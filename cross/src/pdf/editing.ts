// Editing existing page content: text, images, redaction. Uses the content engine on pdf-lib objects.
import {
  PDFDocument, PDFName, PDFDict, PDFHexString, PDFNumber, PDFOperator, PDFOperatorNames as Ops, PDFRawStream, popGraphicsState, pushGraphicsState, rgb,
  setCharacterSpacing, setCharacterSqueeze, type PDFFont, type PDFPage,
} from 'pdf-lib';
import { LayoutParagraph, lineSize } from '../engine/layout';
import { FontEncoder, GraphicObject, PageContent, Rect, contains, containsRect, intersects, isSpace, maxX, maxY, rect } from '../engine/pageContent';
import { num, op } from '../engine/contentStream';
import { fontFor, wrap } from './fonts';
import { listAnnots, isRedaction, deleteAnnot } from './annots';
import { toPngOrJpeg } from './ops';

export interface TextStyle {
  family: string; bold: boolean; italic: boolean; size: number; color: [number, number, number]; alignment: 'left' | 'center' | 'right' | 'justify';
  underline?: boolean;
  /** Multiplies the paragraph's own line spacing (1 keeps it). */
  lineSpacing?: number;
  /** Extra space after each paragraph (each line of the edit that ends with Enter), in points. */
  spaceAfter?: number;
  /** Each paragraph of the edit as a list item. */
  list?: 'bullet' | 'number';
  /** Extra space after every letter, as a share of the font size. Kept small (up to 6%): readers split wider-spaced
   *  words into single letters, which breaks search and copy. */
  charSpacing?: number;
  /** Letter width in percent (100 keeps the font's own). */
  hScale?: number;
}

/** A marker the text already starts with ("•", "-", "3." or "3)"), so a list doesn't get two. */
const MARKER = /^\s*(?:[•●▪◦‣∙–-]|\d+[.)])\s+/;

/** Replaces a paragraph (or adds new text when `block` is null), removing the original glyphs from the page. */
export async function commitText(doc: PDFDocument, pageIndex: number, block: LayoutParagraph | null, text: string, style: TextStyle,
  origin: { x: number; y: number }, wrapWidth?: number, boxWidth?: number,
  /** Scanned text: paint these rects in the paper colour first, hiding the old letters' pixels. */
  cover?: { rects: Rect[]; paper: [number, number, number] }) {
  const page = doc.getPage(pageIndex);
  // The characters drawn, list markers included (the font chosen must have them all).
  const withMarkers = style.list === 'bullet' ? `${text}•` : style.list === 'number' ? `${text}0123456789.` : text;
  let own: FontEncoder | null = null;
  if (block) {
    const pc = new PageContent(doc, page);
    own = ownFont(pc, block, style, withMarkers);
    const rects = block.lines.map((l) => ({ x: l.rect.x - 0.5, y: l.rect.y - 0.5, w: l.rect.w + 1, h: l.rect.h + 1 }));
    // The blank spaces padding each line (a table cell's fill, however long) go too: left behind, they'd sit among
    // the new letters and split its words when the text is read or copied.
    const blanks = pc.glyphs.filter((g) => g.upright && isSpace(g));
    const padded = rects.map((line) => {
      const row = blanks.filter((g) => Math.abs(g.rect.y + g.rect.h / 2 - (line.y + line.h / 2)) < line.h / 2);
      // One sweep each way: a space within reach of the run so far extends it.
      let lo = line.x, hi = maxX(line);
      for (const g of [...row].sort((a, b) => a.rect.x - b.rect.x)) if (maxX(g.rect) > hi && g.rect.x <= hi + g.size * 1.5) hi = maxX(g.rect);
      for (const g of [...row].sort((a, b) => maxX(b.rect) - maxX(a.rect))) if (g.rect.x < lo && maxX(g.rect) >= lo - g.size * 1.5) lo = g.rect.x;
      return { x: lo, y: line.y, w: hi - lo, h: line.h };
    });
    const centre = (g: { rect: Rect }) => ({ x: g.rect.x + g.rect.w / 2, y: g.rect.y + g.rect.h / 2 });
    pc.removeGlyphs((g) => g.upright && (rects.some((r) => contains(r, centre(g))) || (isSpace(g) && padded.some((r) => contains(r, centre(g))))));
    pc.commit();
  }
  for (const r of cover?.rects ?? []) page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: rgb(...cover!.paper) });
  if (!text.trim()) return;
  const pitch = (block?.pitch ?? style.size * 1.2) * (style.lineSpacing ?? 1);
  const color = rgb(...style.color);
  /** Lays the text out paragraph by paragraph: list markers in a hanging indent, lines wrapped and aligned in the box,
   *  justified lines spread word by word, the chosen space after each paragraph. */
  const place = (width: (t: string) => number, draw: (t: string, x: number, y: number) => void) => {
    const measure = { widthOfTextAtSize: (t: string) => width(t) };
    const indent = style.list ? style.size * 1.4 : 0;
    let y = origin.y, n = 0;
    for (const para of text.split('\n')) {
      const body = style.list ? para.replace(MARKER, '') : para;
      const lines = wrap(body, measure, 1, wrapWidth === undefined ? undefined : Math.max(style.size * 3, wrapWidth - indent));
      if (style.list && body.trim()) draw(style.list === 'bullet' ? '•' : `${++n}.`, origin.x, y);
      lines.forEach((line, i) => {
        const last = i === lines.length - 1;
        const left = origin.x + indent;
        const w = width(line);
        const box = (boxWidth ?? wrapWidth ?? w + indent) - indent;
        const words = line.split(/ +/).filter(Boolean);
        if (style.alignment === 'justify' && !last && words.length > 1 && !RTL_CHAR.test(line) && box > w) {
          const gap = (box - words.reduce((sum, t) => sum + width(t), 0)) / (words.length - 1);
          let x = left;
          for (const t of words) { draw(t, x, y); x += width(t) + gap; }
          if (style.underline) underline(left, y, box);
        } else {
          const x = left + (style.alignment === 'center' ? (box - w) / 2 : style.alignment === 'right' ? box - w : 0);
          draw(line, x, y);
          if (style.underline && w > 0) underline(x, y, w);
        }
        y -= pitch;
      });
      y -= style.spaceAfter ?? 0;
    }
  };
  // Letter spacing and width, set around each piece of text (both drawing paths inherit them); widths follow the
  // PDF's rule: (advance + spacing per letter) × width. Right-to-left text is left as it is: spacing would break
  // its joined letters.
  const cs = (style.charSpacing ?? 0) * style.size, hs = (style.hScale ?? 100) / 100;
  const plainSpacing = !cs && hs === 1;
  const spaced = (width: (t: string) => number) => (t: string) =>
    plainSpacing || RTL_CHAR.test(t) ? width(t) : (width(t) + cs * [...t].length) * hs;
  const inState = (draw: (t: string, x: number, y: number) => void) => (t: string, x: number, y: number) => {
    if (plainSpacing || RTL_CHAR.test(t)) return draw(t, x, y);
    page.pushOperators(pushGraphicsState(), setCharacterSpacing(cs), setCharacterSqueeze(hs * 100));
    draw(t, x, y);
    page.pushOperators(popGraphicsState());
  };
  const underline = (x: number, y: number, w: number) =>
    page.drawRectangle({ x, y: y - style.size * 0.13, width: w, height: Math.max(0.5, style.size * 0.06), color });
  if (own) {
    // The paragraph's own embedded font has every letter: the new text looks exactly like the old.
    const enc = own;
    place(spaced((t) => encodedWidth(enc, t) * style.size), inState((t, x, y) => drawEncoded(doc, page, enc, t, x, y, style.size, style.color)));
    return;
  }
  const font = await fontFor(doc, { family: style.family, bold: style.bold, italic: style.italic, text: withMarkers });
  // Mixed Arabic and Latin text: the Arabic font may lack Latin letters, so left-to-right runs get their own font.
  const latinText = text.replace(new RegExp(RTL_CHAR.source, 'g'), '');
  const latin = RTL_CHAR.test(text) && /\p{L}/u.test(latinText)
    ? await fontFor(doc, { family: style.family, bold: style.bold, italic: style.italic, text: latinText }) : font;
  place(spaced((t) => font.widthOfTextAtSize(t, style.size)), inState((t, x, y) => drawBidi(page, t, x, y, style.size, font, color, latin)));
}

const RTL_CHAR = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;

/**
 * The paragraph's own font, when the edit can be written with it: one embedded font for the whole paragraph, the
 * family and weight unchanged, left-to-right text (shaped scripts need the font's shaping tables), and every new
 * character already drawn with that font on this page. Size and colour may change.
 */
function ownFont(pc: PageContent, block: LayoutParagraph, style: TextStyle, text: string): FontEncoder | null {
  const runs = block.lines.flatMap((l) => l.runs);
  const first = runs[0];
  if (!first || RTL_CHAR.test(text) || runs.some((r) => r.invisible || r.resource !== first.resource)) return null;
  const was = styleOf(block);
  if (style.family !== was.family || style.bold !== was.bold || style.italic !== was.italic) return null;
  return pc.encoderFor(first.resource, text);
}

/** A space the font has no glyph for is a gap of a quarter em, as the original's spacing was drawn. */
const GAP = 0.25;
const encodedWidth = (enc: FontEncoder, text: string) =>
  [...text].reduce((w, ch) => { const c = enc.codes.get(ch); return w + (c === undefined ? GAP : enc.width(c)); }, 0);

function drawEncoded(doc: PDFDocument, page: PDFPage, enc: FontEncoder, line: string, x: number, y: number, size: number, color: [number, number, number]) {
  const parts: (PDFHexString | PDFNumber)[] = [];
  let hex = '';
  const flush = () => { if (hex) parts.push(PDFHexString.of(hex)); hex = ''; };
  for (const ch of line) {
    const code = enc.codes.get(ch);
    if (code === undefined) { flush(); parts.push(PDFNumber.of(-GAP * 1000)); continue; }
    hex += code.toString(16).padStart(enc.bytesPerCode * 2, '0');
  }
  flush();
  const n = (v: number) => PDFNumber.of(Math.round(v * 1000) / 1000);
  page.pushOperators(
    PDFOperator.of(Ops.PushGraphicsState), PDFOperator.of(Ops.BeginText),
    PDFOperator.of(Ops.SetFontAndSize, [PDFName.of(enc.resource), n(size)]),
    PDFOperator.of(Ops.NonStrokingColorRgb, color.map(n)),
    PDFOperator.of(Ops.SetTextMatrix, [1, 0, 0, 1, x, y].map(n)),
    PDFOperator.of(Ops.ShowTextAdjusted, [doc.context.obj(parts)]),
    PDFOperator.of(Ops.EndText), PDFOperator.of(Ops.PopGraphicsState));
}

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
