// Annotations with real appearance streams, drawn in local coordinates (BBox at the origin), so moving
// or resizing only changes /Rect. Comments stay standard PDF annotations other readers understand.
import {
  PDFArray, PDFDict, PDFDocument, PDFFont, PDFHexString, PDFName, PDFNumber, PDFPage, PDFRef, PDFString,
} from 'pdf-lib';
import { Rect, maxX, maxY, rect, union } from '../engine/pageContent';
import { fontFor } from './fonts';

export type RGB = [number, number, number];
export const REDACTION_TAG = 'MKPDF-Redaction';
const f = (n: number) => (Math.round(n * 1000) / 1000).toString();
const col = (c: RGB) => c.map(f).join(' ');

export interface AnnotInfo {
  page: number;
  ref: PDFRef | null;
  index: number;
  subtype: string;
  rect: Rect;
  contents: string;
  author: string;
  modified: string;
  color: RGB | null;
  name: string;
}

const COMMENT_TYPES = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Text', 'FreeText', 'Ink', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'Stamp', 'Caret', 'FileAttachment']);
export const isComment = (a: AnnotInfo) => COMMENT_TYPES.has(a.subtype) && a.name !== REDACTION_TAG;
export const isRedaction = (a: AnnotInfo) => a.name === REDACTION_TAG || (a.subtype === 'Square' && a.contents === 'Redaction mark');

const text = (d: PDFDict, k: string) => {
  const v = d.lookup(PDFName.of(k));
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '';
};
const numbers = (a: unknown) => (a instanceof PDFArray ? a.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0)) : []);

export function listAnnots(doc: PDFDocument): AnnotInfo[] {
  const out: AnnotInfo[] = [];
  doc.getPages().forEach((page, pi) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const d = annots.lookup(i);
      if (!(d instanceof PDFDict)) continue;
      const st = d.lookup(PDFName.of('Subtype'));
      const r = numbers(d.lookup(PDFName.of('Rect')));
      const c = numbers(d.lookup(PDFName.of('C')));
      out.push({
        page: pi, ref: raw instanceof PDFRef ? raw : null, index: i, subtype: st instanceof PDFName ? st.decodeText() : '',
        rect: r.length === 4 ? rect(Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.abs(r[2] - r[0]), Math.abs(r[3] - r[1])) : rect(0, 0, 0, 0),
        contents: text(d, 'Contents'), author: text(d, 'T'), modified: text(d, 'M'),
        color: c.length === 3 ? (c as RGB) : null, name: text(d, 'NM'),
      });
    }
  });
  return out;
}

export function annotDict(doc: PDFDocument, a: AnnotInfo): PDFDict | null {
  const v = doc.getPage(a.page).node.Annots()?.lookup(a.index);
  return v instanceof PDFDict ? v : null;
}

function pdfDate(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** A form XObject drawn in a w×h box at the origin. */
function appearance(doc: PDFDocument, w: number, h: number, content: string, resources: Record<string, unknown> = {}): PDFRef {
  const stream = doc.context.stream(content, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, f(w), f(h)].map(Number), Resources: resources,
  } as never);
  return doc.context.register(stream);
}

export const author = () => localStorage.getItem('mkpdf.author') || 'MK PDF';

function add(doc: PDFDocument, page: PDFPage, fields: Record<string, unknown>, ap: PDFRef, r: Rect): PDFRef {
  const dict = doc.context.obj({
    Type: 'Annot', Rect: [r.x, r.y, maxX(r), maxY(r)], F: 4, M: PDFString.of(pdfDate()), T: PDFHexString.fromText(author()),
    AP: { N: ap }, ...fields,
  } as never);
  const ref = doc.context.register(dict);
  page.node.addAnnot(ref);
  return ref;
}

const multiply = (doc: PDFDocument) => ({ ExtGState: { GS0: doc.context.obj({ Type: 'ExtGState', BM: 'Multiply' } as never) } });

export function addMarkup(doc: PDFDocument, pageIndex: number, rects: Rect[], kind: 'Highlight' | 'Underline' | 'StrikeOut', color: RGB) {
  if (!rects.length) return;
  const page = doc.getPage(pageIndex);
  const u = rects.reduce<Rect | null>((a, r) => union(a, r), null)!;
  const pad = 1;
  const box = rect(u.x - pad, u.y - pad, u.w + 2 * pad, u.h + 2 * pad);
  let content = '';
  for (const r of rects) {
    const x = r.x - box.x, y = r.y - box.y;
    if (kind === 'Highlight') content += `/GS0 gs ${col(color)} rg ${f(x)} ${f(y)} ${f(r.w)} ${f(r.h)} re f\n`;
    else {
      const ly = kind === 'Underline' ? y + r.h * 0.08 : y + r.h * 0.48;
      content += `${col(color)} RG ${f(Math.max(0.6, r.h * 0.07))} w ${f(x)} ${f(ly)} m ${f(x + r.w)} ${f(ly)} l S\n`;
    }
  }
  const quads = rects.flatMap((r) => [r.x, maxY(r), maxX(r), maxY(r), r.x, r.y, maxX(r), r.y]);
  add(doc, page, { Subtype: kind, C: color, QuadPoints: quads, ...(kind === 'Highlight' ? { CA: 1 } : {}) },
    appearance(doc, box.w, box.h, content, kind === 'Highlight' ? multiply(doc) : {}), box);
}

export function addNote(doc: PDFDocument, pageIndex: number, x: number, y: number, color: RGB, contents = '') {
  const s = 22;
  const content = `${col(color)} rg 0.35 0.3 0.1 RG 0.8 w 1 4 ${s - 2} ${s - 5} re B\n0.35 0.3 0.1 RG 1.2 w 5 ${s - 8} m ${s - 5} ${s - 8} l S 5 ${s - 12} m ${s - 5} ${s - 12} l S 5 ${s - 16} m ${s - 9} ${s - 16} l S\n${col(color)} rg 5 4 m 4 0 l 10 4 l f`;
  add(doc, doc.getPage(pageIndex), { Subtype: 'Text', Name: 'Comment', C: color, Contents: PDFHexString.fromText(contents), Open: false },
    appearance(doc, s, s, content), rect(x, y - s, s, s));
}

export async function addFreeText(doc: PDFDocument, pageIndex: number, x: number, y: number, value: string, size: number, color: RGB,
  style: { family?: string; bold?: boolean; italic?: boolean } = {}) {
  const font = await fontFor(doc, { family: style.family ?? 'Helvetica', bold: !!style.bold, italic: !!style.italic, text: value });
  const lines = value.split('\n');
  const w = Math.max(24, ...lines.map((l) => font.widthOfTextAtSize(l, size))) + 6;
  const lh = size * 1.25, h = lh * lines.length + 4;
  const content = 'BT\n' + lines.map((l, i) => `/F0 ${f(size)} Tf ${col(color)} rg 1 0 0 1 3 ${f(h - 2 - size - i * lh + size * 0.22)} Tm ${font.encodeText(l).toString()} Tj`).join('\n') + '\nET';
  add(doc, doc.getPage(pageIndex), {
    Subtype: 'FreeText', Contents: PDFHexString.fromText(value), DA: PDFString.of(`/Helv ${f(size)} Tf ${col(color)} rg`),
    MKSize: size, MKColor: color, MKFamily: PDFHexString.fromText(style.family ?? 'Helvetica'),
  }, appearance(doc, w, h, content, { Font: { F0: font.ref } }), rect(x, y - h / 2, w, h));
}

export function addInk(doc: PDFDocument, pageIndex: number, strokes: { x: number; y: number }[][], color: RGB, width: number) {
  const pts = strokes.flat();
  if (pts.length < 2) return;
  const pad = width + 2;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const box = rect(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + 2 * pad, Math.max(...ys) - Math.min(...ys) + 2 * pad);
  let content = `${col(color)} RG ${f(width)} w 1 J 1 j\n`;
  for (const s of strokes) {
    if (s.length < 2) continue;
    content += s.map((p, i) => `${f(p.x - box.x)} ${f(p.y - box.y)} ${i ? 'l' : 'm'}`).join(' ') + ' S\n';
  }
  add(doc, doc.getPage(pageIndex), { Subtype: 'Ink', C: color, BS: { W: width }, InkList: strokes.map((s) => s.flatMap((p) => [p.x, p.y])) },
    appearance(doc, box.w, box.h, content), box);
}

export function addShape(doc: PDFDocument, pageIndex: number, kind: 'Square' | 'Circle' | 'Line' | 'Arrow', a: { x: number; y: number }, b: { x: number; y: number }, color: RGB, width: number, fill?: RGB) {
  const page = doc.getPage(pageIndex);
  if (kind === 'Line' || kind === 'Arrow') {
    const pad = width * 4 + 6;
    const box = rect(Math.min(a.x, b.x) - pad, Math.min(a.y, b.y) - pad, Math.abs(a.x - b.x) + 2 * pad, Math.abs(a.y - b.y) + 2 * pad);
    const x1 = a.x - box.x, y1 = a.y - box.y, x2 = b.x - box.x, y2 = b.y - box.y;
    let content = `${col(color)} RG ${col(color)} rg ${f(width)} w 1 J ${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l S\n`;
    if (kind === 'Arrow') {
      const ang = Math.atan2(y2 - y1, x2 - x1), L = width * 4 + 6;
      const p = (d: number) => `${f(x2 - L * Math.cos(ang + d))} ${f(y2 - L * Math.sin(ang + d))}`;
      content += `${f(x2)} ${f(y2)} m ${p(0.45)} l ${p(-0.45)} l h f\n`;
    }
    add(doc, page, { Subtype: 'Line', C: color, BS: { W: width }, L: [a.x, a.y, b.x, b.y], ...(kind === 'Arrow' ? { LE: ['None', 'ClosedArrow'], IC: color } : {}) },
      appearance(doc, box.w, box.h, content), box);
    return;
  }
  const box = rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const hw = width / 2;
  let content = `${col(color)} RG ${f(width)} w ${fill ? col(fill) + ' rg ' : ''}`;
  if (kind === 'Square') content += `${f(hw)} ${f(hw)} ${f(box.w - width)} ${f(box.h - width)} re ${fill ? 'B' : 'S'}`;
  else {
    const rx = box.w / 2 - hw, ry = box.h / 2 - hw, cx = box.w / 2, cy = box.h / 2, k = 0.5523;
    content += `${f(cx + rx)} ${f(cy)} m ${f(cx + rx)} ${f(cy + ry * k)} ${f(cx + rx * k)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c ` +
      `${f(cx - rx * k)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ry * k)} ${f(cx - rx)} ${f(cy)} c ` +
      `${f(cx - rx)} ${f(cy - ry * k)} ${f(cx - rx * k)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c ` +
      `${f(cx + rx * k)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ry * k)} ${f(cx + rx)} ${f(cy)} c ${fill ? 'B' : 'S'}`;
  }
  add(doc, page, { Subtype: kind, C: color, BS: { W: width }, ...(fill ? { IC: fill } : {}) }, appearance(doc, box.w, box.h, content), box);
}

/** A picture stamp (signature, initials, stamp or image), movable and resizable later. */
export async function addImageStamp(doc: PDFDocument, pageIndex: number, r: Rect, png: Uint8Array, kind: string) {
  const isJpeg = png[0] === 0xff && png[1] === 0xd8;
  const img = isJpeg ? await doc.embedJpg(png) : await doc.embedPng(png);
  const ap = appearance(doc, r.w, r.h, `q ${f(r.w)} 0 0 ${f(r.h)} 0 0 cm /Im0 Do Q`, { XObject: { Im0: img.ref } });
  add(doc, doc.getPage(pageIndex), { Subtype: 'Stamp', Name: kind.replace(/\s/g, ''), Contents: PDFHexString.fromText(kind) }, ap, r);
}

export function addLink(doc: PDFDocument, pageIndex: number, r: Rect, target: string) {
  const page = doc.getPage(pageIndex);
  const n = Number(target);
  const action = Number.isInteger(n) && n >= 1 && n <= doc.getPageCount()
    ? { Dest: [doc.getPage(n - 1).ref, 'XYZ', null, doc.getPage(n - 1).getHeight(), null] }
    : { A: { S: 'URI', URI: PDFString.of(/^[a-z]+:/i.test(target) ? target : `https://${target}`) } };
  const dict = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [r.x, r.y, maxX(r), maxY(r)], Border: [0, 0, 0], ...action } as never);
  page.node.addAnnot(doc.context.register(dict));
}

export function addRedactionMark(doc: PDFDocument, pageIndex: number, r: Rect) {
  const content = `1 0 0 RG 0.95 0.75 0.75 rg 1.5 w 0.75 0.75 ${f(r.w - 1.5)} ${f(r.h - 1.5)} re B`;
  add(doc, doc.getPage(pageIndex), { Subtype: 'Square', C: [1, 0, 0], IC: [0.95, 0.75, 0.75], CA: 0.6, NM: PDFHexString.fromText(REDACTION_TAG), Contents: PDFHexString.fromText('Redaction mark') },
    appearance(doc, r.w, r.h, content), r);
}

/** Whiteout: a white box that hides what's under it (not a redaction). */
export function addWhiteout(doc: PDFDocument, pageIndex: number, r: Rect) {
  add(doc, doc.getPage(pageIndex), { Subtype: 'Square', C: [1, 1, 1], IC: [1, 1, 1], BS: { W: 0 }, Contents: PDFHexString.fromText('Whiteout') },
    appearance(doc, r.w, r.h, `1 1 1 rg 0 0 ${f(r.w)} ${f(r.h)} re f`), r);
}

/** Moves (offset) or resizes (new rect) an annotation, keeping its geometry data in step. */
export function setAnnotRect(doc: PDFDocument, a: AnnotInfo, to: Rect) {
  const d = annotDict(doc, a);
  if (!d) return;
  const dx = to.x - a.rect.x, dy = to.y - a.rect.y;
  d.set(PDFName.of('Rect'), doc.context.obj([to.x, to.y, maxX(to), maxY(to)]));
  const moved = Math.abs(to.w - a.rect.w) < 0.01 && Math.abs(to.h - a.rect.h) < 0.01;
  if (!moved) return;
  const shift = (key: string) => {
    const v = numbers(d.lookup(PDFName.of(key)));
    if (v.length) d.set(PDFName.of(key), doc.context.obj(v.map((n, i) => n + (i % 2 ? dy : dx))));
  };
  shift('QuadPoints'); shift('L'); shift('Vertices');
  const ink = d.lookup(PDFName.of('InkList'));
  if (ink instanceof PDFArray) d.set(PDFName.of('InkList'), doc.context.obj(ink.asArray().map((s) => numbers(s).map((n, i) => n + (i % 2 ? dy : dx)))));
}

export function deleteAnnot(doc: PDFDocument, a: AnnotInfo) {
  const annots = doc.getPage(a.page).node.Annots();
  annots?.remove(a.index);
}

export function setContents(doc: PDFDocument, a: AnnotInfo, value: string) {
  annotDict(doc, a)?.set(PDFName.of('Contents'), PDFHexString.fromText(value));
}

/** Regenerates a free-text box with new text, size or colour. */
export async function restyleFreeText(doc: PDFDocument, a: AnnotInfo, change: { text?: string; size?: number; color?: RGB }) {
  const d = annotDict(doc, a);
  if (!d) return;
  const sizeObj = d.lookup(PDFName.of('MKSize'));
  const size = change.size ?? (sizeObj instanceof PDFNumber ? sizeObj.asNumber() : 12);
  const stored = numbers(d.lookup(PDFName.of('MKColor')));
  const color: RGB = change.color ?? (stored.length === 3 ? (stored as RGB) : [0, 0, 0]);
  const family = text(d, 'MKFamily') || 'Helvetica';
  const value = change.text ?? a.contents;
  deleteAnnot(doc, a);
  const top = maxY(a.rect);
  await addFreeText(doc, a.page, a.rect.x, top - (size * 1.25 * value.split('\n').length + 4) / 2, value, size, color, { family });
}

/** Copies an annotation (e.g. a signature) to the same place on other pages. */
export function copyAnnotToPages(doc: PDFDocument, a: AnnotInfo, pages: number[]) {
  const d = annotDict(doc, a);
  if (!d) return;
  for (const p of pages) {
    if (p === a.page) continue;
    const clone = d.clone(doc.context);
    clone.delete(PDFName.of('P'));
    doc.getPage(p).node.addAnnot(doc.context.register(clone));
  }
}

export type { PDFFont };
