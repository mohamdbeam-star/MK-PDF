// Page and document operations (all run inside DocModel.apply, so each is one undo step).
import { PDFDocument, PDFName, PDFPage, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { fontFor, wrap } from './fonts';
import { loadPdf } from '../engine/load';

export const LETTER: [number, number] = [612, 792];
export const A4: [number, number] = [595.28, 841.89];

/** Parses "1-3, 5, 8-" into zero-based page indices. */
export function parseRanges(text: string, count: number): number[] | null {
  const out: number[] = [];
  for (const part of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const lo = m[1] ? Number(m[1]) : 1, hi = m[2] ? Number(m[2]) : count;
      if (lo < 1 || hi > count || lo > hi) return null;
      for (let i = lo; i <= hi; i++) out.push(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n < 1 || n > count) return null;
      out.push(n - 1);
    } else return null;
  }
  return out.length ? out : null;
}

export function rotatePages(doc: PDFDocument, indices: number[], by: number) {
  for (const i of indices) {
    const p = doc.getPage(i);
    p.setRotation(degrees((((p.getRotation().angle + by) % 360) + 360) % 360));
  }
}

export function deletePages(doc: PDFDocument, indices: number[]) {
  if (indices.length >= doc.getPageCount()) throw new Error('A PDF needs at least one page.');
  for (const i of [...new Set(indices)].sort((a, b) => b - a)) doc.removePage(i);
}

export function insertBlank(doc: PDFDocument, after: number) {
  const ref = doc.getPage(Math.max(0, Math.min(after, doc.getPageCount() - 1)));
  doc.insertPage(after + 1, [ref.getWidth(), ref.getHeight()]);
}

/** Reorders pages: `order[i]` is the old index of the page that should end up at position i. */
export async function reorder(doc: PDFDocument, order: number[]) {
  const copies = await doc.copyPages(doc, order);
  const n = doc.getPageCount();
  copies.forEach((p) => doc.addPage(p));
  for (let i = n - 1; i >= 0; i--) doc.removePage(i);
}

export async function duplicate(doc: PDFDocument, indices: number[]) {
  const sorted = [...indices].sort((a, b) => a - b);
  const copies = await doc.copyPages(doc, sorted);
  copies.forEach((p, k) => doc.insertPage(sorted[k] + 1 + k, p));
}

/** Pages from other PDFs or images, inserted after `after`. */
export async function insertFiles(doc: PDFDocument, after: number, files: { name: string; bytes: Uint8Array }[]) {
  let at = after + 1;
  for (const file of files) {
    for (const page of await pagesFrom(doc, file)) doc.insertPage(at++, page);
  }
}

/** Turns a PDF or an image into pages owned by `doc`. */
export async function pagesFrom(doc: PDFDocument, file: { name: string; bytes: Uint8Array }, paper?: [number, number]): Promise<PDFPage[]> {
  const b = file.bytes;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    const src = await loadPdf(b);
    return doc.copyPages(src, src.getPageIndices());
  }
  const png = await toPngOrJpeg(b);
  const img = png.jpeg ? await doc.embedJpg(png.bytes) : await doc.embedPng(png.bytes);
  const natural: [number, number] = [img.width * 0.75, img.height * 0.75];
  const page = PDFPage.create(doc);
  if (!paper) {
    page.setSize(...natural);
    page.drawImage(img, { x: 0, y: 0, width: natural[0], height: natural[1] });
  } else {
    const land = natural[0] > natural[1];
    const sheet: [number, number] = land ? [paper[1], paper[0]] : paper;
    page.setSize(...sheet);
    const s = Math.min((sheet[0] - 72) / natural[0], (sheet[1] - 72) / natural[1], 1);
    const w = natural[0] * s, h = natural[1] * s;
    page.drawImage(img, { x: (sheet[0] - w) / 2, y: (sheet[1] - h) / 2, width: w, height: h });
  }
  return [page];
}

/** JPEG and PNG pass through; other formats (WebP, HEIC where supported, GIF, BMP, SVG) via a canvas. */
export async function toPngOrJpeg(b: Uint8Array): Promise<{ bytes: Uint8Array; jpeg: boolean }> {
  if (b[0] === 0xff && b[1] === 0xd8) return { bytes: b, jpeg: true };
  if (b[0] === 0x89 && b[1] === 0x50) return { bytes: b, jpeg: false };
  const bitmap = await createImageBitmap(new Blob([b as BlobPart]));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), jpeg: false };
}

export async function combine(files: { name: string; bytes: Uint8Array }[], paper?: [number, number]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  for (const f of files) for (const p of await pagesFrom(doc, f, paper)) doc.addPage(p);
  return doc.save();
}

/** A new PDF containing only `indices` of `doc`. */
export async function extract(doc: PDFDocument, indices: number[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const p of await out.copyPages(doc, indices)) out.addPage(p);
  out.setTitle(doc.getTitle() ?? '');
  return out.save();
}

export async function splitGroups(doc: PDFDocument, mode: 'every' | 'ranges' | 'parts' | 'size', value: string): Promise<number[][]> {
  const n = doc.getPageCount();
  if (mode === 'every') { const k = Math.max(1, Number(value) || 1); return chunk(n, k); }
  if (mode === 'parts') { const k = Math.max(1, Math.ceil(n / Math.max(1, Number(value) || 2))); return chunk(n, k); }
  if (mode === 'ranges') {
    const groups = value.split(';').map((r) => parseRanges(r, n));
    if (groups.some((g) => !g)) throw new Error('Check the page ranges.');
    return groups as number[][];
  }
  // By size: each page's own size, added up until the limit.
  const limit = (Number(value) || 5) * 1_000_000;
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) sizes.push((await extract(doc, [i])).length);
  const groups: number[][] = [];
  let cur: number[] = [], total = 0;
  sizes.forEach((s, i) => {
    if (cur.length && total + s > limit) { groups.push(cur); cur = []; total = 0; }
    cur.push(i); total += s;
  });
  if (cur.length) groups.push(cur);
  return groups;
}
const chunk = (n: number, k: number) => Array.from({ length: Math.ceil(n / k) }, (_, i) => Array.from({ length: Math.min(k, n - i * k) }, (_, j) => i * k + j));

// MARK: page design

/** Display size (rotation applied) and a mapper from display coordinates (origin bottom-left as shown) to page space. */
export function displayFrame(page: PDFPage) {
  const c = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const size = rot % 180 ? { w: c.height, h: c.width } : { w: c.width, h: c.height };
  const toPage = (x: number, y: number) => {
    switch (rot) {
      case 90: return { x: c.x + c.width - y, y: c.y + x };
      case 180: return { x: c.x + c.width - x, y: c.y + c.height - y };
      case 270: return { x: c.x + y, y: c.y + c.height - x };
      default: return { x: c.x + x, y: c.y + y };
    }
  };
  return { size, rot, toPage };
}

/** Draws upright text in display space: `anchor` 0…1 positions the text box on the point. */
export async function drawText(doc: PDFDocument, page: PDFPage, text: string, at: { x: number; y: number }, anchor: { x: number; y: number },
  o: { size: number; color?: [number, number, number]; opacity?: number; angle?: number; bold?: boolean; family?: string }) {
  const font = await fontFor(doc, { family: o.family ?? 'Helvetica', bold: !!o.bold, italic: false, text });
  const { rot, toPage } = displayFrame(page);
  const w = font.widthOfTextAtSize(text, o.size), h = font.heightAtSize(o.size, { descender: false });
  const angle = ((o.angle ?? 0) * Math.PI) / 180;
  // Offset from the anchor point to the text origin, rotated with the text.
  const ox = -w * anchor.x, oy = -h * anchor.y;
  const dx = ox * Math.cos(angle) - oy * Math.sin(angle), dy = ox * Math.sin(angle) + oy * Math.cos(angle);
  const p = toPage(at.x + dx, at.y + dy);
  page.drawText(text, { x: p.x, y: p.y, size: o.size, font, color: rgb(...(o.color ?? [0, 0, 0])), opacity: o.opacity ?? 1, rotate: degrees((o.angle ?? 0) + rot) });
}

export async function watermark(doc: PDFDocument, indices: number[], o: { text?: string; image?: Uint8Array; size: number; opacity: number; angle: number; color: [number, number, number] }) {
  const img = o.image ? await (async () => { const p = await toPngOrJpeg(o.image!); return p.jpeg ? doc.embedJpg(p.bytes) : doc.embedPng(p.bytes); })() : null;
  for (const i of indices) {
    const page = doc.getPage(i);
    const { size, rot, toPage } = displayFrame(page);
    if (img) {
      const w = (size.w * o.size) / 160, h = (w * img.height) / img.width;
      const a = (o.angle * Math.PI) / 180;
      const ox = -w / 2, oy = -h / 2;
      const p = toPage(size.w / 2 + ox * Math.cos(a) - oy * Math.sin(a), size.h / 2 + ox * Math.sin(a) + oy * Math.cos(a));
      page.drawImage(img, { x: p.x, y: p.y, width: w, height: h, opacity: o.opacity, rotate: degrees(o.angle + rot) });
    } else if (o.text) {
      await drawText(doc, page, o.text, { x: size.w / 2, y: size.h / 2 }, { x: 0.5, y: 0.5 }, { size: o.size, color: o.color, opacity: o.opacity, angle: o.angle, bold: true });
    }
  }
}

/** Header/footer slots: 0-2 top left/centre/right, 3-5 bottom. Tokens: {page} {pages} {date} {file}. */
export async function headerFooter(doc: PDFDocument, slots: string[], o: { size: number; margin: number; file: string; bates?: { prefix: string; start: number; digits: number; slot: number } }) {
  const n = doc.getPageCount();
  const date = new Date().toLocaleDateString();
  for (let i = 0; i < n; i++) {
    const page = doc.getPage(i);
    const { size } = displayFrame(page);
    const place = async (slot: number, text: string) => {
      const x = [o.margin, size.w / 2, size.w - o.margin][slot % 3];
      const ax = [0, 0.5, 1][slot % 3];
      const top = slot < 3;
      await drawText(doc, page, text, { x, y: top ? size.h - o.margin : o.margin }, { x: ax, y: top ? 1 : 0 }, { size: o.size });
    };
    for (let s = 0; s < 6; s++) {
      const t = slots[s];
      if (t) await place(s, t.replace(/\{page\}/g, String(i + 1)).replace(/\{pages\}/g, String(n)).replace(/\{date\}/g, date).replace(/\{file\}/g, o.file));
    }
    if (o.bates) await place(o.bates.slot, o.bates.prefix + String(o.bates.start + i).padStart(o.bates.digits, '0'));
  }
}

export function cropPages(doc: PDFDocument, indices: number[], r: { x: number; y: number; w: number; h: number } | null) {
  for (const i of indices) {
    const p = doc.getPage(i);
    if (!r) { const m = p.getMediaBox(); p.setCropBox(m.x, m.y, m.width, m.height); }
    else p.setCropBox(r.x, r.y, r.w, r.h);
  }
}

export function flattenForms(doc: PDFDocument) {
  try { doc.getForm().flatten(); } catch { /* no form */ }
}

export function clearForm(doc: PDFDocument) {
  const form = doc.getForm();
  for (const field of form.getFields()) {
    const f = field as unknown as { setText?(t: string): void; uncheck?(): void; clear?(): void };
    try { if (f.setText) f.setText(''); else if (f.uncheck) f.uncheck(); else f.clear?.(); } catch { /* read-only */ }
  }
}

export function addFormField(doc: PDFDocument, pageIndex: number, kind: 'text' | 'checkbox' | 'dropdown', r: { x: number; y: number; w: number; h: number }, options: string[] = []) {
  const form = doc.getForm();
  const page = doc.getPage(pageIndex);
  const name = (base: string) => { let i = 1; while (form.getFieldMaybe(`${base}${i}`)) i++; return `${base}${i}`; };
  const at = { x: r.x, y: r.y, width: r.w, height: r.h, borderColor: rgb(0.3, 0.45, 0.9), backgroundColor: rgb(0.93, 0.95, 1) };
  if (kind === 'text') { const f = form.createTextField(name('Text')); if (r.h > 30) f.enableMultiline(); f.addToPage(page, at); }
  else if (kind === 'checkbox') form.createCheckBox(name('Check')).addToPage(page, at);
  else { const f = form.createDropdown(name('Choice')); f.addOptions(options.length ? options : ['Option 1', 'Option 2']); f.addToPage(page, at); }
}

export function setMetadata(doc: PDFDocument, m: { title: string; author: string; subject: string; keywords: string }) {
  doc.setTitle(m.title); doc.setAuthor(m.author); doc.setSubject(m.subject);
  doc.setKeywords(m.keywords.split(',').map((s) => s.trim()).filter(Boolean));
}

export function removeMetadata(doc: PDFDocument) {
  doc.setTitle(''); doc.setAuthor(''); doc.setSubject(''); doc.setKeywords([]); doc.setCreator(''); doc.setProducer('MK PDF');
  doc.catalog.delete(PDFName.of('Metadata'));
}

export { wrap };
