// Document operations matching the Mac app: flattening comments, comment summaries, bookmarks, form fields,
// replacing pages, splitting by bookmarks, grayscale and PDF/X-3 output.
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString,
  decodePDFRawStream,
} from 'pdf-lib';
import { zlibSync } from 'fflate';
import { Op, PDFValue, num, nameV, op, parse, serialize } from '../engine/contentStream';
import { listAnnots, isComment } from './annots';

const N = (s: string) => PDFName.of(s);
const numOf = (v: unknown) => (v instanceof PDFNumber ? v.asNumber() : 0);
const textOf = (v: unknown) => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '');

// MARK: comments

/** Draws comments (or every annotation but links and form fields) into their pages and removes them. */
export function flattenAnnotations(doc: PDFDocument, which: 'comments' | 'all' = 'comments') {
  const keep = new Set(['Link', 'Widget', 'Popup']);
  doc.getPages().forEach((page, pi) => {
    const annots = page.node.Annots();
    if (!annots) return;
    const kept: PDFRef[] = [];
    let content = '';
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const dict = doc.context.lookup(ref);
      if (!(dict instanceof PDFDict)) continue;
      const subtype = dict.lookup(N('Subtype'));
      const kind = subtype instanceof PDFName ? subtype.decodeText() : '';
      const hidden = (numOf(dict.lookup(N('F'))) & 2) !== 0;
      if (kind === 'Popup') continue; // dropped with its parent, or kept below when the parent is
      if (keep.has(kind) || (which === 'comments' && !isCommentKind(kind))) { if (ref instanceof PDFRef) kept.push(ref); continue; }
      if (hidden) continue;
      let ap = dict.lookup(N('AP'));
      let normal = ap instanceof PDFDict ? ap.lookup(N('N')) : undefined;
      if (normal instanceof PDFDict && !(normal instanceof PDFStream)) {
        const state = dict.lookup(N('AS'));
        normal = state instanceof PDFName ? normal.lookup(state) : undefined;
      }
      const apRef = ap instanceof PDFDict ? (ap.get(N('N')) instanceof PDFRef ? ap.get(N('N')) : undefined) : undefined;
      if (!(normal instanceof PDFStream)) continue;
      const rect = dict.lookup(N('Rect'));
      if (!(rect instanceof PDFArray) || rect.size() < 4) continue;
      const [x0, y0, x1, y1] = [0, 1, 2, 3].map((k) => numOf(rect.lookup(k)));
      // The appearance's bounding box (after its own Matrix) is fitted into the annotation's rectangle.
      const bbox = normal.dict.lookup(N('BBox'));
      const b = bbox instanceof PDFArray ? [0, 1, 2, 3].map((k) => numOf(bbox.lookup(k))) : [0, 0, x1 - x0, y1 - y0];
      const m = normal.dict.lookup(N('Matrix'));
      const mm = m instanceof PDFArray ? [0, 1, 2, 3, 4, 5].map((k) => numOf(m.lookup(k))) : [1, 0, 0, 1, 0, 0];
      const corners = [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]].map(([x, y]) => [mm[0] * x + mm[2] * y + mm[4], mm[1] * x + mm[3] * y + mm[5]]);
      const bx0 = Math.min(...corners.map((c) => c[0])), bx1 = Math.max(...corners.map((c) => c[0]));
      const by0 = Math.min(...corners.map((c) => c[1])), by1 = Math.max(...corners.map((c) => c[1]));
      const sx = bx1 > bx0 ? (Math.max(x0, x1) - Math.min(x0, x1)) / (bx1 - bx0) : 1, sy = by1 > by0 ? (Math.max(y0, y1) - Math.min(y0, y1)) / (by1 - by0) : 1;
      const tx = Math.min(x0, x1) - bx0 * sx, ty = Math.min(y0, y1) - by0 * sy;
      const xref = (apRef as PDFRef | undefined) ?? doc.context.register(normal);
      const name = page.node.newXObject('MKa', xref).decodeText();
      content += `q ${f(sx)} 0 0 ${f(sy)} ${f(tx)} ${f(ty)} cm /${name} Do Q\n`;
    }
    if (!content) return;
    page.node.addContentStream(doc.context.register(doc.context.flateStream(`q\n${content}Q\n`)));
    // Popups whose parent stays are kept too.
    const keptPopups: PDFRef[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const d = doc.context.lookup(ref);
      if (!(d instanceof PDFDict) || !(ref instanceof PDFRef)) continue;
      const sub = d.lookup(N('Subtype'));
      if (sub instanceof PDFName && sub.decodeText() === 'Popup') {
        const parent = d.get(N('Parent'));
        if (parent instanceof PDFRef && kept.some((k) => k.toString() === parent.toString())) keptPopups.push(ref);
      }
    }
    page.node.set(N('Annots'), doc.context.obj([...kept, ...keptPopups]));
    void pi;
  });
}
const isCommentKind = (k: string) => ['Text', 'FreeText', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Ink', 'Square', 'Circle', 'Line',
  'Polygon', 'PolyLine', 'Stamp', 'Caret', 'FileAttachment', 'Sound'].includes(k);
const f = (n: number) => (Math.round(n * 1000) / 1000).toString();

/** A readable summary of the document's comments (page, type, author, date, text), as an HTML page. */
export function commentSummary(doc: PDFDocument, title: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const rows = listAnnots(doc).filter(isComment).sort((a, b) => a.page - b.page || a.index - b.index).map((a) => {
    const d = doc.getPage(a.page).node.Annots()?.lookup(a.index);
    const date = d instanceof PDFDict ? textOf(d.lookup(N('M'))) || textOf(d.lookup(N('CreationDate'))) : '';
    const when = /D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/.exec(date);
    return `<tr><td>${a.page + 1}</td><td>${esc(KIND[a.subtype] ?? a.subtype)}</td><td>${esc(a.author ?? '')}</td>` +
      `<td>${when ? `${when[1]}-${when[2]}-${when[3]}${when[4] ? ` ${when[4]}:${when[5] ?? '00'}` : ''}` : ''}</td><td>${esc(a.contents ?? '')}</td></tr>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Comments – ${esc(title)}</title><style>
body{font:14px -apple-system,Segoe UI,Roboto,sans-serif;margin:32px;color:#222}h1{font-size:20px}table{border-collapse:collapse;width:100%}
th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}th{background:#f4f4f6}td:first-child{width:48px}</style></head>
<body><h1>Comments in ${esc(title)}</h1><p>${rows.length} comment${rows.length === 1 ? '' : 's'}</p>
<table><tr><th>Page</th><th>Type</th><th>Author</th><th>Date</th><th>Comment</th></tr>${rows.join('')}</table></body></html>`;
}
const KIND: Record<string, string> = { Text: 'Note', FreeText: 'Text box', Highlight: 'Highlight', Underline: 'Underline', StrikeOut: 'Strikethrough',
  Ink: 'Drawing', Square: 'Rectangle', Circle: 'Oval', Line: 'Line', Stamp: 'Stamp', Squiggly: 'Squiggle' };

// MARK: bookmarks

export interface Bookmark { ref: PDFRef; title: string; page: number | null; depth: number }

/** The outline, depth first (the order pdf.js lists it in). */
export function listBookmarks(doc: PDFDocument): Bookmark[] {
  const out: Bookmark[] = [];
  const outlines = doc.catalog.lookup(N('Outlines'));
  if (!(outlines instanceof PDFDict)) return out;
  const pageRefs = doc.getPages().map((p) => p.ref.toString());
  const visit = (first: unknown, depth: number) => {
    let ref = first;
    for (let guard = 0; ref instanceof PDFRef && guard < 10_000; guard++) {
      const item = doc.context.lookup(ref);
      if (!(item instanceof PDFDict)) break;
      out.push({ ref, title: textOf(item.lookup(N('Title'))), page: destPage(doc, item, pageRefs), depth });
      visit(item.get(N('First')), depth + 1);
      ref = item.get(N('Next'));
    }
  };
  visit(outlines.get(N('First')), 0);
  return out;
}

function destPage(doc: PDFDocument, item: PDFDict, pageRefs: string[]): number | null {
  let dest = item.lookup(N('Dest'));
  const action = item.lookup(N('A'));
  if (!dest && action instanceof PDFDict) dest = action.lookup(N('D'));
  if (dest instanceof PDFString || dest instanceof PDFHexString || dest instanceof PDFName) {
    const key = dest instanceof PDFName ? dest.decodeText() : dest.decodeText();
    dest = namedDest(doc, key) as typeof dest;
  }
  if (dest instanceof PDFDict) dest = dest.lookup(N('D'));
  if (dest instanceof PDFArray && dest.size()) {
    const target = dest.get(0);
    if (target instanceof PDFRef) { const i = pageRefs.indexOf(target.toString()); return i >= 0 ? i : null; }
    if (target instanceof PDFNumber) return target.asNumber();
  }
  return null;
}

function namedDest(doc: PDFDocument, key: string): unknown {
  const dests = doc.catalog.lookup(N('Dests'));
  if (dests instanceof PDFDict) { const d = dests.lookup(N(key)); if (d) return d; }
  const names = doc.catalog.lookup(N('Names'));
  const tree = names instanceof PDFDict ? names.lookup(N('Dests')) : undefined;
  const search = (node: unknown): unknown => {
    if (!(node instanceof PDFDict)) return undefined;
    const pairs = node.lookup(N('Names'));
    if (pairs instanceof PDFArray) for (let i = 0; i + 1 < pairs.size(); i += 2) if (textOf(pairs.lookup(i)) === key) return pairs.lookup(i + 1);
    const kids = node.lookup(N('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) { const r = search(kids.lookup(i)); if (r) return r; }
    return undefined;
  };
  return search(tree);
}

/** Adds a top-level bookmark at the end of the outline, pointing at `pageIndex`. */
export function addBookmark(doc: PDFDocument, title: string, pageIndex: number) {
  let outlines = doc.catalog.lookup(N('Outlines'));
  if (!(outlines instanceof PDFDict)) {
    outlines = doc.context.obj({ Type: 'Outlines', Count: 0 });
    doc.catalog.set(N('Outlines'), doc.context.register(outlines as PDFDict));
  }
  const root = outlines as PDFDict;
  const rootRef = doc.catalog.get(N('Outlines')) as PDFRef;
  const page = doc.getPage(pageIndex);
  const item = doc.context.obj({ Title: PDFHexString.fromText(title), Parent: rootRef, Dest: [page.ref, 'XYZ', null, null, null] });
  const ref = doc.context.register(item);
  const last = root.get(N('Last'));
  if (last instanceof PDFRef) {
    item.set(N('Prev'), last);
    (doc.context.lookup(last) as PDFDict).set(N('Next'), ref);
  } else root.set(N('First'), ref);
  root.set(N('Last'), ref);
  root.set(N('Count'), PDFNumber.of(Math.abs(numOf(root.lookup(N('Count')))) + 1));
}

export function renameBookmark(doc: PDFDocument, ref: PDFRef, title: string) {
  const item = doc.context.lookup(ref);
  if (item instanceof PDFDict) item.set(N('Title'), PDFHexString.fromText(title));
}

/** Removes a bookmark (and the bookmarks under it). */
export function deleteBookmark(doc: PDFDocument, ref: PDFRef) {
  const item = doc.context.lookup(ref);
  if (!(item instanceof PDFDict)) return;
  const parentRef = item.get(N('Parent')), prev = item.get(N('Prev')), next = item.get(N('Next'));
  const parent = parentRef instanceof PDFRef ? doc.context.lookup(parentRef) : undefined;
  if (prev instanceof PDFRef) { const p = doc.context.lookup(prev) as PDFDict; if (next instanceof PDFRef) p.set(N('Next'), next); else p.delete(N('Next')); }
  if (next instanceof PDFRef) { const n = doc.context.lookup(next) as PDFDict; if (prev instanceof PDFRef) n.set(N('Prev'), prev); else n.delete(N('Prev')); }
  if (parent instanceof PDFDict) {
    if (parent.get(N('First'))?.toString() === ref.toString()) { if (next instanceof PDFRef) parent.set(N('First'), next); else parent.delete(N('First')); }
    if (parent.get(N('Last'))?.toString() === ref.toString()) { if (prev instanceof PDFRef) parent.set(N('Last'), prev); else parent.delete(N('Last')); }
    const count = numOf(parent.lookup(N('Count')));
    if (count) parent.set(N('Count'), PDFNumber.of(count > 0 ? count - 1 : count + 1));
  }
}

/** Page groups starting at each top-level bookmark (for splitting a document by chapter). */
export function bookmarkGroups(doc: PDFDocument): { title: string; pages: number[] }[] {
  const starts = listBookmarks(doc).filter((b) => b.depth === 0 && b.page !== null) as (Bookmark & { page: number })[];
  const unique = starts.filter((b, i) => starts.findIndex((o) => o.page === b.page) === i).sort((a, b) => a.page - b.page);
  const n = doc.getPageCount();
  return unique.map((b, i) => ({ title: b.title, pages: Array.from({ length: (unique[i + 1]?.page ?? n) - b.page }, (_, k) => b.page + k) }))
    .filter((g) => g.pages.length);
}

// MARK: form fields

export interface FieldInfo { name: string; kind: string }
export function listFields(doc: PDFDocument): FieldInfo[] {
  try {
    return doc.getForm().getFields().map((fl) => ({ name: fl.getName(), kind: fl.constructor.name.replace(/^PDF/, '').replace(/Field$/, '') || 'Field' }));
  } catch { return []; }
}
export function renameField(doc: PDFDocument, name: string, to: string) {
  const field = doc.getForm().getField(name);
  field.acroField.dict.set(N('T'), PDFHexString.fromText(to));
}
export function deleteField(doc: PDFDocument, name: string) {
  const form = doc.getForm();
  form.removeField(form.getField(name));
}

// MARK: pages

/** Replaces page `index` with page `from` of another PDF. */
export async function replacePage(doc: PDFDocument, index: number, file: Uint8Array, from = 0) {
  const src = await PDFDocument.load(file, { ignoreEncryption: true });
  const [copy] = await doc.copyPages(src, [Math.min(from, src.getPageCount() - 1)]);
  doc.insertPage(index, copy);
  doc.removePage(index + 1);
}

// MARK: grayscale

/** Converts colours to gray: colour operators in every content stream and form, and RGB images. Text stays text. */
export async function grayscale(doc: PDFDocument) {
  const seen = new Set<string>();
  for (const page of doc.getPages()) {
    const res = page.node.Resources();
    const contents = page.node.Contents();
    const streams: PDFRef[] = [];
    if (contents instanceof PDFArray) for (let i = 0; i < contents.size(); i++) { const r = contents.get(i); if (r instanceof PDFRef) streams.push(r); }
    else { const r = page.node.get(N('Contents')); if (r instanceof PDFRef) streams.push(r); }
    for (const r of streams) grayStream(doc, r, res);
    await grayResources(doc, res, seen);
  }
}

async function grayResources(doc: PDFDocument, res: PDFDict | undefined, seen: Set<string>) {
  const xobjects = res?.lookup(N('XObject'));
  if (!(xobjects instanceof PDFDict)) return;
  for (const [, value] of xobjects.entries()) {
    if (!(value instanceof PDFRef) || seen.has(value.toString())) continue;
    seen.add(value.toString());
    const s = doc.context.lookup(value);
    if (!(s instanceof PDFRawStream)) continue;
    const sub = s.dict.lookup(N('Subtype'));
    if (sub instanceof PDFName && sub.decodeText() === 'Form') {
      const formRes = s.dict.lookup(N('Resources'));
      grayStream(doc, value, formRes instanceof PDFDict ? formRes : res);
      await grayResources(doc, formRes instanceof PDFDict ? formRes : undefined, seen);
    } else if (sub instanceof PDFName && sub.decodeText() === 'Image') {
      await grayImage(doc, value, s);
    }
  }
}

const luma = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;
const cmykGray = (c: number, m: number, y: number, k: number) => 1 - Math.min(1, 0.3 * c + 0.59 * m + 0.11 * y + k);

function grayStream(doc: PDFDocument, ref: PDFRef, res: PDFDict | undefined) {
  const s = doc.context.lookup(ref);
  if (!(s instanceof PDFRawStream)) return;
  let bytes: Uint8Array;
  try { bytes = decodePDFRawStream(s).decode(); } catch { return; }
  const ops = parse(bytes);
  // Colour space components in effect for fill and stroke (3 = RGB-like, 4 = CMYK-like, 0 = leave alone).
  let fill = 0, stroke = 0;
  const spaceSize = (name: string): number => {
    if (name === 'DeviceRGB' || name === 'RGB' || name === 'CalRGB') return 3;
    if (name === 'DeviceCMYK' || name === 'CMYK') return 4;
    const cs = (res?.lookup(N('ColorSpace')) as PDFDict | undefined)?.lookup?.(N(name));
    if (cs instanceof PDFArray) {
      const family = cs.lookup(0);
      const fam = family instanceof PDFName ? family.decodeText() : '';
      if (fam === 'CalRGB') return 3;
      if (fam === 'ICCBased') { const icc = cs.lookup(1); const n = icc instanceof PDFStream ? numOf(icc.dict.lookup(N('N'))) : 0; return n === 3 || n === 4 ? n : 0; }
    }
    return 0;
  };
  let changed = false;
  const out: Op[] = ops.map((o) => {
    const n = o.operands.map((v) => (v.t === 'num' ? v.v : NaN));
    const gray = (vals: number[]) => (vals.length === 3 ? luma(vals[0], vals[1], vals[2]) : cmykGray(vals[0], vals[1], vals[2], vals[3]));
    switch (o.op) {
      case 'rg': changed = true; return op('g', [num(gray(n))]);
      case 'RG': changed = true; return op('G', [num(gray(n))]);
      case 'k': changed = true; return op('g', [num(gray(n))]);
      case 'K': changed = true; return op('G', [num(gray(n))]);
      case 'cs': case 'CS': {
        const nm = o.operands[0]?.t === 'name' ? (o.operands[0] as { v: string }).v : '';
        const size = spaceSize(nm);
        if (o.op === 'cs') fill = size; else stroke = size;
        if (!size) return o;
        changed = true;
        return op(o.op, [nameV('DeviceGray')]);
      }
      case 'sc': case 'scn': case 'SC': case 'SCN': {
        const size = o.op[0] === 's' ? fill : stroke;
        if (!size || n.length !== size || n.some(Number.isNaN)) return o;
        changed = true;
        return op(o.op, [num(gray(n))]);
      }
      default: return o;
    }
  });
  if (!changed) return;
  const dict = s.dict.clone(doc.context);
  dict.delete(N('DecodeParms'));
  dict.set(N('Filter'), N('FlateDecode'));
  const data = zlibSync(serialize(out));
  dict.set(N('Length'), PDFNumber.of(data.length));
  doc.context.assign(ref, PDFRawStream.of(dict, data));
}

async function grayImage(doc: PDFDocument, ref: PDFRef, s: PDFRawStream) {
  const cs = s.dict.lookup(N('ColorSpace'));
  const filter = s.dict.lookup(N('Filter'));
  const filters = filter instanceof PDFName ? [filter.decodeText()] : filter instanceof PDFArray ? filter.asArray().map((x) => (x instanceof PDFName ? x.decodeText() : '')) : [];
  const csName = cs instanceof PDFName ? cs.decodeText() : cs instanceof PDFArray && cs.lookup(0) instanceof PDFName ? (cs.lookup(0) as PDFName).decodeText() : '';
  if (s.dict.lookup(N('ImageMask'))) return;
  const w = numOf(s.dict.lookup(N('Width'))), h = numOf(s.dict.lookup(N('Height')));
  if (!w || !h) return;
  if (filters.length === 1 && filters[0] === 'DCTDecode' && typeof createImageBitmap === 'function') {
    // A JPEG: decoded and re-encoded in gray by the platform's image codec.
    try {
      const bmp = await createImageBitmap(new Blob([s.getContents() as BlobPart], { type: 'image/jpeg' }));
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width; canvas.height = bmp.height;
      const ctx = canvas.getContext('2d')!;
      ctx.filter = 'grayscale(1)';
      ctx.drawImage(bmp, 0, 0);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      if (!blob) return;
      const data = new Uint8Array(await blob.arrayBuffer());
      const dict = s.dict.clone(doc.context);
      dict.set(N('Length'), PDFNumber.of(data.length));
      dict.delete(N('Decode'));
      dict.set(N('ColorSpace'), N('DeviceRGB'));
      doc.context.assign(ref, PDFRawStream.of(dict, data));
    } catch { /* leave the image as it is */ }
    return;
  }
  // 8-bit RGB or CMYK pixels without a predictor: averaged to gray.
  const bpc = numOf(s.dict.lookup(N('BitsPerComponent')));
  const comps = csName === 'DeviceRGB' || csName === 'CalRGB' ? 3 : csName === 'DeviceCMYK' ? 4 : 0;
  if (!comps || bpc !== 8 || s.dict.lookup(N('DecodeParms')) || !(filters.length === 0 || (filters.length === 1 && filters[0] === 'FlateDecode'))) return;
  let px: Uint8Array;
  try { px = decodePDFRawStream(s).decode(); } catch { return; }
  if (px.length < w * h * comps) return;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * comps;
    out[i] = comps === 3 ? Math.round(luma(px[o], px[o + 1], px[o + 2]))
      : Math.round(255 * cmykGray(px[o] / 255, px[o + 1] / 255, px[o + 2] / 255, px[o + 3] / 255));
  }
  const data = zlibSync(out);
  const dict = s.dict.clone(doc.context);
  dict.set(N('ColorSpace'), N('DeviceGray'));
  dict.set(N('Filter'), N('FlateDecode'));
  dict.delete(N('Decode'));
  dict.set(N('Length'), PDFNumber.of(data.length));
  doc.context.assign(ref, PDFRawStream.of(dict, data));
}

// MARK: PDF/X-3

/** Marks the document as PDF/X-3 for print: an sRGB output intent, trim boxes and the PDF/X keys. */
export function pdfx3(doc: PDFDocument) {
  const profile = doc.context.flateStream(srgbProfile(), { N: 3 });
  const intent = doc.context.obj({
    Type: 'OutputIntent', S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    RegistryName: PDFString.of('http://www.color.org'), Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: doc.context.register(profile),
  });
  doc.catalog.set(N('OutputIntents'), doc.context.obj([doc.context.register(intent)]));
  for (const page of doc.getPages()) {
    if (!page.node.get(N('TrimBox'))) {
      const b = page.getCropBox();
      page.node.set(N('TrimBox'), doc.context.obj([b.x, b.y, b.x + b.width, b.y + b.height]));
    }
  }
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (info instanceof PDFDict) {
    info.set(N('GTS_PDFXVersion'), PDFString.of('PDF/X-3:2003'));
    info.set(N('Trapped'), N('False'));
  }
  doc.setTitle(doc.getTitle() || 'Document');
}

/** A compact ICC v2 display profile for sRGB (D65 primaries, gamma 2.2). */
function srgbProfile(): Uint8Array {
  const tags: [string, Uint8Array][] = [];
  const s15 = (v: number) => { const n = Math.round(v * 65536); return [(n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const xyz = (x: number, y: number, z: number) => new Uint8Array([...ascii('XYZ '), 0, 0, 0, 0, ...s15(x), ...s15(y), ...s15(z)]);
  const desc = (t: string) => {
    const body = [...ascii('desc'), 0, 0, 0, 0, ...u32(t.length + 1), ...ascii(t), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...new Array(67).fill(0)];
    return new Uint8Array(body);
  };
  const curve = new Uint8Array([...ascii('curv'), 0, 0, 0, 0, 0, 0, 0, 1, 2, 51]); // gamma 2.2 (u8Fixed8)
  tags.push(['desc', desc('sRGB IEC61966-2.1')]);
  tags.push(['cprt', new Uint8Array([...ascii('text'), 0, 0, 0, 0, ...ascii('No copyright, use freely'), 0])]);
  tags.push(['wtpt', xyz(0.9505, 1, 1.089)]);
  tags.push(['rXYZ', xyz(0.4361, 0.2225, 0.0139)]);
  tags.push(['gXYZ', xyz(0.3851, 0.7169, 0.0971)]);
  tags.push(['bXYZ', xyz(0.1431, 0.0606, 0.7141)]);
  tags.push(['rTRC', curve], ['gTRC', curve], ['bTRC', curve]);
  const tableSize = 4 + tags.length * 12;
  let offset = 128 + tableSize;
  const table: number[] = [...u32(tags.length)];
  const bodies: number[] = [];
  for (const [sig, data] of tags) {
    const padded = [...data, ...new Array((4 - (data.length % 4)) % 4).fill(0)];
    table.push(...ascii(sig), ...u32(offset), ...u32(data.length));
    bodies.push(...padded);
    offset += padded.length;
  }
  const size = 128 + table.length + bodies.length;
  const header = [...u32(size), ...ascii('none'), 2, 16, 0, 0, ...ascii('mntr'), ...ascii('RGB '), ...ascii('XYZ '),
    0x07, 0xd0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, ...ascii('acsp'), ...ascii('APPL'), 0, 0, 0, 0, ...ascii('none'), ...ascii('none'),
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...s15(0.9642), ...s15(1), ...s15(0.8249), ...ascii('none')];
  while (header.length < 128) header.push(0);
  return new Uint8Array([...header, ...table, ...bodies]);
}
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

export type { PDFValue };
