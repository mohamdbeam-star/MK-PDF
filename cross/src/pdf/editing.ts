// Editing existing page content: text, images, redaction. Uses the content engine on pdf-lib objects.
import { PDFDocument, PDFName, PDFDict, PDFRawStream, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { LayoutParagraph, lineSize } from '../engine/layout';
import { GraphicObject, PageContent, Rect, contains, containsRect, intersects, maxX, maxY, rect } from '../engine/pageContent';
import { num, op } from '../engine/contentStream';
import { fontFor, wrap } from './fonts';
import { listAnnots, isRedaction, deleteAnnot } from './annots';
import { toPngOrJpeg } from './ops';

export interface TextStyle { family: string; bold: boolean; italic: boolean; size: number; color: [number, number, number]; alignment: 'left' | 'center' | 'right' | 'justify' }

/** Replaces a paragraph (or adds new text when `block` is null), removing the original glyphs from the page. */
export async function commitText(doc: PDFDocument, pageIndex: number, block: LayoutParagraph | null, text: string, style: TextStyle,
  origin: { x: number; y: number }, wrapWidth?: number, boxWidth?: number,
  /** Scanned text: paint these rects in the paper colour first, hiding the old letters' pixels. */
  cover?: { rects: Rect[]; paper: [number, number, number] }) {
  const page = doc.getPage(pageIndex);
  if (block) {
    const pc = new PageContent(doc, page);
    const rects = block.lines.map((l) => ({ x: l.rect.x - 0.5, y: l.rect.y - 0.5, w: l.rect.w + 1, h: l.rect.h + 1 }));
    pc.removeGlyphs((g) => g.upright && rects.some((r) => contains(r, { x: g.rect.x + g.rect.w / 2, y: g.rect.y + g.rect.h / 2 })));
    pc.commit();
  }
  for (const r of cover?.rects ?? []) page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: rgb(...cover!.paper) });
  if (!text.trim()) return;
  const font = await fontFor(doc, { family: style.family, bold: style.bold, italic: style.italic, text });
  // Mixed Arabic and Latin text: the Arabic font may lack Latin letters, so left-to-right runs get their own font.
  const latinText = text.replace(new RegExp(RTL_CHAR.source, 'g'), '');
  const latin = RTL_CHAR.test(text) && /\p{L}/u.test(latinText)
    ? await fontFor(doc, { family: style.family, bold: style.bold, italic: style.italic, text: latinText }) : font;
  const pitch = block?.pitch ?? style.size * 1.2;
  const lines = wrap(text, font, style.size, wrapWidth);
  lines.forEach((line, i) => {
    const w = font.widthOfTextAtSize(line, style.size);
    const box = boxWidth ?? wrapWidth ?? w;
    const x = origin.x + (style.alignment === 'center' ? (box - w) / 2 : style.alignment === 'right' ? box - w : 0);
    drawBidi(page, line, x, origin.y - i * pitch, style.size, font, rgb(...style.color), latin);
  });
}

const RTL_CHAR = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;

/**
 * Draws one line in visual order. The shaper lays out a whole string right to left once it sees Arabic, which
 * would also reverse numbers and Latin words; so the line is split into right-to-left and left-to-right runs,
 * the runs are ordered for the line's direction, and each is shaped on its own.
 */
export function drawBidi(page: PDFPage, line: string, x: number, y: number, size: number, font: PDFFont, color: ReturnType<typeof rgb>, latin = font) {
  if (!RTL_CHAR.test(line)) { page.drawText(line, { x, y, size, font, color }); return; }
  const runs: { text: string; rtl: boolean }[] = [];
  for (const ch of line) {
    const strong = RTL_CHAR.test(ch) ? true : /[\p{L}\p{N}]/u.test(ch) ? false : null;
    const last = runs[runs.length - 1];
    if (last && (strong === null || strong === last.rtl)) last.text += ch;
    else runs.push({ text: ch, rtl: strong ?? true });
  }
  const firstStrong = runs.find((r) => /[\p{L}\p{N}]/u.test(r.text));
  const visual = firstStrong?.rtl ? [...runs].reverse() : runs;
  let cursor = x;
  for (const r of visual) {
    const f = r.rtl ? font : latin;
    page.drawText(r.text, { x: cursor, y, size, font: f, color });
    cursor += f.widthOfTextAtSize(r.text, size);
  }
}

export function styleOf(block: LayoutParagraph): TextStyle {
  const r = block.lines[0].runs[0];
  return { family: r.font.family, bold: r.font.bold, italic: r.font.italic, size: lineSize(block.lines[0]), color: r.color, alignment: block.alignment };
}

export function moveObject(doc: PDFDocument, pageIndex: number, obj: GraphicObject, to: Rect) {
  const pc = new PageContent(doc, doc.getPage(pageIndex));
  const match = pc.objects.find((o) => o.opIndex === obj.opIndex);
  if (match) { pc.transformObject(match, to); pc.commit(); }
}

export function deleteObject(doc: PDFDocument, pageIndex: number, obj: GraphicObject) {
  const pc = new PageContent(doc, doc.getPage(pageIndex));
  const match = pc.objects.find((o) => o.opIndex === obj.opIndex);
  if (match) { pc.removeObject(match); pc.commit(); }
}

export async function replaceObject(doc: PDFDocument, pageIndex: number, obj: GraphicObject, image: Uint8Array) {
  deleteObject(doc, pageIndex, obj);
  const p = await toPngOrJpeg(image);
  const img = p.jpeg ? await doc.embedJpg(p.bytes) : await doc.embedPng(p.bytes);
  const b = obj.bounds;
  const s = Math.min(b.w / img.width, b.h / img.height);
  const w = img.width * s, h = img.height * s;
  doc.getPage(pageIndex).drawImage(img, { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, width: w, height: h });
}

export function removeAllImages(doc: PDFDocument) {
  for (const page of doc.getPages()) {
    const pc = new PageContent(doc, page);
    let changed = false;
    for (let o = pc.objects.find((x) => x.kind !== 'form'); o; o = pc.objects.find((x) => x.kind !== 'form')) { pc.removeObject(o); changed = true; }
    if (changed) pc.commit();
  }
}

/** Decodes an image XObject to RGBA pixels when it's a JPEG or plain 8-bit RGB/gray. */
async function decodeImage(stream: PDFRawStream, jpeg: boolean, w: number, h: number): Promise<ImageBitmap | ImageData | null> {
  if (jpeg) return createImageBitmap(new Blob([stream.getContents() as BlobPart], { type: 'image/jpeg' }));
  const { decodePDFRawStream } = await import('pdf-lib');
  const bpc = (stream.dict.lookup(PDFName.of('BitsPerComponent')) as { asNumber(): number } | undefined)?.asNumber();
  const cs = stream.dict.lookup(PDFName.of('ColorSpace'));
  const name = cs instanceof PDFName ? cs.decodeText() : '';
  if (bpc !== 8 || (name !== 'DeviceRGB' && name !== 'DeviceGray')) return null;
  let raw: Uint8Array;
  try { raw = decodePDFRawStream(stream).decode(); } catch { return null; }
  const comps = name === 'DeviceRGB' ? 3 : 1;
  if (raw.length < w * h * comps) return null;
  const out = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const s = i * comps;
    out.data[i * 4] = raw[s]; out.data[i * 4 + 1] = raw[s + (comps === 3 ? 1 : 0)]; out.data[i * 4 + 2] = raw[s + (comps === 3 ? 2 : 0)]; out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** Blacks out the parts of an image under `rects`, rewriting its pixels (so nothing is recoverable). */
async function redactImagePixels(doc: PDFDocument, pc: PageContent, obj: GraphicObject, rects: Rect[]): Promise<boolean> {
  const info = pc.imageStream(obj);
  if (!info || !info.width || !info.height) return false;
  const src = await decodeImage(info.stream, info.jpeg, info.width, info.height);
  if (!src) return false;
  const canvas = new OffscreenCanvas(info.width, info.height);
  const ctx = canvas.getContext('2d')!;
  if (src instanceof ImageData) ctx.putImageData(src, 0, 0); else ctx.drawImage(src, 0, 0);
  ctx.fillStyle = '#000';
  const b = obj.bounds;
  for (const r of rects) {
    if (!intersects(r, b)) continue;
    // Page rect → image pixels (images are drawn upright into their bounds).
    const x0 = ((Math.max(r.x, b.x) - b.x) / b.w) * info.width, x1 = ((Math.min(maxX(r), maxX(b)) - b.x) / b.w) * info.width;
    const y0 = ((maxY(b) - Math.min(maxY(r), maxY(b))) / b.h) * info.height, y1 = ((maxY(b) - Math.max(r.y, b.y)) / b.h) * info.height;
    ctx.fillRect(Math.floor(x0), Math.floor(y0), Math.ceil(x1 - x0) + 1, Math.ceil(y1 - y0) + 1);
  }
  const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
  const replacement = doc.context.stream(jpeg, {
    Type: 'XObject', Subtype: 'Image', Width: info.width, Height: info.height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode',
  } as never);
  const xo = pc.resources?.lookup(PDFName.of('XObject'));
  if (xo instanceof PDFDict) xo.set(PDFName.of(obj.name), doc.context.register(replacement));
  return true;
}

/** Applies every redaction mark: removes text under it, blacks out image pixels, paints black boxes.
 *  Returns pages that couldn't be handled exactly (vector drawings or unusual images), for flattening. */
export async function applyRedactions(doc: PDFDocument): Promise<number[]> {
  const marks = listAnnots(doc).filter(isRedaction);
  const byPage = new Map<number, Rect[]>();
  for (const m of marks) byPage.set(m.page, [...(byPage.get(m.page) ?? []), m.rect]);
  const fallback: number[] = [];
  for (const [pi, rects] of byPage) {
    const pc = new PageContent(doc, doc.getPage(pi));
    let ok = true;
    for (const o of [...pc.objects].reverse()) {
      if (!rects.some((r) => intersects(r, o.bounds))) continue;
      if (rects.some((r) => containsRect({ x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 }, o.bounds))) { pc.removeObject(o); continue; }
      if (o.kind === 'image' && (await redactImagePixels(doc, pc, o, rects))) continue;
      ok = false;
    }
    pc.removeGlyphs((g) => rects.some((r) => {
      const ix = Math.min(maxX(r), maxX(g.rect)) - Math.max(r.x, g.rect.x), iy = Math.min(maxY(r), maxY(g.rect)) - Math.max(r.y, g.rect.y);
      return ix > 0 && iy > 0 && ix * iy > g.rect.w * g.rect.h * 0.3;
    }));
    pc.append([op('g', [num(0)]), ...rects.map((r) => op('re', [r.x, r.y, r.w, r.h].map(num))), op('f')]);
    pc.commit();
    if (!ok) fallback.push(pi);
  }
  // Remove the marks themselves (highest index first per page).
  for (const m of marks.sort((a, b) => b.page - a.page || b.index - a.index)) deleteAnnot(doc, m);
  return fallback;
}

/** Replaces a page with a picture of itself (used when exact redaction isn't possible). */
export async function flattenPageToImage(doc: PDFDocument, pageIndex: number, jpeg: Uint8Array) {
  const page = doc.getPage(pageIndex);
  const crop = page.getCropBox();
  const img = await doc.embedJpg(jpeg);
  page.node.delete(PDFName.of('Annots'));
  const empty = doc.context.flateStream(new Uint8Array());
  page.node.set(PDFName.of('Contents'), doc.context.register(empty));
  page.drawImage(img, { x: crop.x, y: crop.y, width: crop.width, height: crop.height });
}

export { rect };
