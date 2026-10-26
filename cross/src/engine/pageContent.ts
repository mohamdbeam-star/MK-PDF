// Interprets a page's content stream so every glyph and placed object has a position, and rewrites it:
// glyph-exact text removal, moving/resizing/deleting images. Port of MKPDFCore/PageContent.swift.
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage, PDFRawStream, PDFRef, PDFStream,
  PDFString, PDFHexString, StandardFontEmbedder, StandardFonts, decodePDFRawStream,
} from 'pdf-lib';
import { Op, PDFValue, num, op, parse, serialize, serializeOp } from './contentStream';

export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m then n (row-vector convention, like PDF). */
export function concat(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export interface Rect { x: number; y: number; w: number; h: number }
export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
export const maxX = (r: Rect) => r.x + r.w;
export const maxY = (r: Rect) => r.y + r.h;
export function union(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(maxX(a), maxX(b)) - x, h: Math.max(maxY(a), maxY(b)) - y };
}
export function intersects(a: Rect, b: Rect) { return a.x < maxX(b) && b.x < maxX(a) && a.y < maxY(b) && b.y < maxY(a); }
export function contains(a: Rect, p: { x: number; y: number }) { return p.x >= a.x && p.x <= maxX(a) && p.y >= a.y && p.y <= maxY(a); }
export function containsRect(a: Rect, b: Rect) { return b.x >= a.x && b.y >= a.y && maxX(b) <= maxX(a) && maxY(b) <= maxY(a); }
export function inset(r: Rect, dx: number, dy: number): Rect { return { x: r.x + dx, y: r.y + dy, w: r.w - 2 * dx, h: r.h - 2 * dy }; }

export function applyToRect(r: Rect, m: Matrix): Rect {
  const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]].map(([x, y]) => [
    x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5],
  ]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

export function applyToPoint(x: number, y: number, m: Matrix) {
  return { x: x * m[0] + y * m[2] + m[4], y: x * m[1] + y * m[3] + m[5] };
}

export interface Glyph {
  element: number;        // index of the string in a TJ array (0 for Tj, ' and ")
  bytes: Uint8Array;
  rect: Rect;             // page space
  displacement: number;   // text-space advance incl. spacing and scaling
  origin: { x: number; y: number };
  size: number;           // effective font size on the page
  upright: boolean;
  fontResource: string;
  color: [number, number, number] | null; // RGB 0…1
  invisible: boolean;     // render mode 3/7 (OCR text layers)
}

export interface TextShow { opIndex: number; glyphs: Glyph[]; fontSize: number; hScale: number; fontResource: string; baseFont: string }

export interface GraphicObject { kind: 'image' | 'form' | 'inline'; opIndex: number; name: string; ctm: Matrix; bounds: Rect }

const isSpace = (g: Glyph) => (g.bytes.length === 1 && g.bytes[0] === 32) || (g.bytes.length === 2 && g.bytes[0] === 0 && (g.bytes[1] === 3 || g.bytes[1] === 32));
export { isSpace };

function lookupDict(d: PDFDict | undefined, key: string): PDFDict | undefined {
  const v = d?.lookup(PDFName.of(key));
  return v instanceof PDFDict ? v : undefined;
}
function lookupNumber(d: PDFDict | undefined, key: string): number | undefined {
  const v = d?.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}
function lookupName(d: PDFDict | undefined, key: string): string | undefined {
  const v = d?.lookup(PDFName.of(key));
  return v instanceof PDFName ? v.decodeText() : undefined;
}

export function streamBytes(s: PDFStream): Uint8Array {
  if (s instanceof PDFRawStream) {
    try { return decodePDFRawStream(s).decode(); } catch { return s.getContents(); }
  }
  return s.getContents();
}

/** Glyph widths and vertical metrics for one font resource. */
class FontMetrics {
  bytesPerCode: number;
  baseFont: string;
  ascent = 0.8;
  descent = -0.2;
  private widths = new Map<number, number>();
  private defaultWidth = 0;
  private scale = 0.001;
  private standard?: StandardFontEmbedder;

  constructor(font: PDFDict) {
    const subtype = lookupName(font, 'Subtype') ?? 'Type1';
    this.baseFont = lookupName(font, 'BaseFont') ?? '';
    let descriptor: PDFDict | undefined;
    if (subtype === 'Type0') {
      this.bytesPerCode = 2;
      this.defaultWidth = 1000;
      const desc = font.lookup(PDFName.of('DescendantFonts'));
      const cid = desc instanceof PDFArray ? desc.lookup(0) : undefined;
      if (cid instanceof PDFDict) {
        this.defaultWidth = lookupNumber(cid, 'DW') ?? 1000;
        descriptor = lookupDict(cid, 'FontDescriptor');
        const w = cid.lookup(PDFName.of('W'));
        if (w instanceof PDFArray) this.cidWidths(w);
      }
    } else {
      this.bytesPerCode = 1;
      descriptor = lookupDict(font, 'FontDescriptor');
      const first = lookupNumber(font, 'FirstChar') ?? 0;
      const w = font.lookup(PDFName.of('Widths'));
      if (w instanceof PDFArray) for (let i = 0; i < w.size(); i++) {
        const v = w.lookup(i);
        if (v instanceof PDFNumber) this.widths.set(first + i, v.asNumber());
      }
      this.defaultWidth = lookupNumber(descriptor, 'MissingWidth') ?? 0;
      if (subtype === 'Type3') {
        const m = font.lookup(PDFName.of('FontMatrix'));
        const a = m instanceof PDFArray ? m.lookup(0) : undefined;
        if (a instanceof PDFNumber) this.scale = a.asNumber();
      }
      if (this.widths.size === 0) {
        const b = this.baseFont.toLowerCase();
        const std = b.includes('courier') ? StandardFonts.Courier : b.includes('times') ? StandardFonts.TimesRoman
          : b.includes('symbol') ? StandardFonts.Symbol : StandardFonts.Helvetica;
        this.standard = StandardFontEmbedder.for(std as never);
      }
    }
    // Type 3 fonts (Chromium "Save as PDF") have no BaseFont; the descriptor still names the font and weight.
    if (!this.baseFont && descriptor) {
      this.baseFont = lookupName(descriptor, 'FontName') ?? '';
      const weight = lookupNumber(descriptor, 'FontWeight') ?? 400;
      if (weight >= 600 && !/bold|black|heavy|semibold|demi/i.test(this.baseFont)) this.baseFont += '-Bold';
    }
    const asc = lookupNumber(descriptor, 'Ascent'), desc = lookupNumber(descriptor, 'Descent');
    if (asc && asc > 0) this.ascent = Math.min(1.2, Math.max(0.5, asc / 1000));
    if (desc && desc < 0) this.descent = Math.max(-0.5, desc / 1000);
  }

  private cidWidths(w: PDFArray) {
    let i = 0;
    const n = w.size();
    while (i < n) {
      const first = w.lookup(i);
      if (!(first instanceof PDFNumber)) { i++; continue; }
      const next = w.lookup(i + 1);
      if (next instanceof PDFArray) {
        for (let j = 0; j < next.size(); j++) {
          const v = next.lookup(j);
          if (v instanceof PDFNumber) this.widths.set(first.asNumber() + j, v.asNumber());
        }
        i += 2;
      } else if (i + 2 < n) {
        const last = w.lookup(i + 1), v = w.lookup(i + 2);
        if (last instanceof PDFNumber && v instanceof PDFNumber && last.asNumber() - first.asNumber() < 70000) {
          for (let c = first.asNumber(); c <= last.asNumber(); c++) this.widths.set(c, v.asNumber());
        }
        i += 3;
      } else break;
    }
  }

  /** Advance per unit font size. */
  width(code: number): number {
    const w = this.widths.get(code);
    if (w !== undefined) return w * this.scale;
    if (this.standard) {
      try { return this.standard.widthOfTextAtSize(String.fromCharCode(code), 1000) * 0.001; } catch { return 0.5; }
    }
    return this.defaultWidth * this.scale;
  }
}

interface GState {
  ctm: Matrix; charSpacing: number; wordSpacing: number; hScale: number; leading: number;
  fontName: string; fontSize: number; rise: number; fill: [number, number, number] | null; stroke: [number, number, number] | null; renderMode: number; lineWidth: number;
  /** Bounding box of the clipping path, page space (null: the whole page). */
  clip: Rect | null;
}

export class PageContent {
  operations: Op[];
  shows: TextShow[] = [];
  objects: GraphicObject[] = [];
  /** Thin painted lines and bars, plus the edges of stroked rectangles (table rules), page space. */
  rules: Rect[] = [];
  /** Colour of each rule (same order as `rules`). */
  ruleColors: [number, number, number][] = [];
  /** Filled rectangles (cell shading, bars), page space. */
  fills: { rect: Rect; color: [number, number, number] }[] = [];
  /** Filled or outlined shapes (rectangles and rounded boxes), page space: banners, cards, callouts. */
  shapes: { rect: Rect; fill?: [number, number, number]; stroke?: [number, number, number]; lineWidth: number; rounded: boolean }[] = [];
  private fonts = new Map<string, FontMetrics | null>();
  private depthAt: number[] = [];
  private ctmAt: Matrix[] = [];
  private endCTM: Matrix = IDENTITY;
  readonly resources?: PDFDict;

  constructor(readonly doc: PDFDocument, readonly page: PDFPage) {
    this.operations = parse(PageContent.contentBytes(page));
    this.resources = page.node.Resources();
    this.analyze();
  }

  static contentBytes(page: PDFPage): Uint8Array {
    const contents = page.node.Contents();
    const parts: Uint8Array[] = [];
    if (contents instanceof PDFStream) parts.push(streamBytes(contents));
    else if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) {
        const s = contents.lookup(i);
        if (s instanceof PDFStream) { parts.push(streamBytes(s)); parts.push(Uint8Array.of(10)); }
      }
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let i = 0;
    for (const p of parts) { out.set(p, i); i += p.length; }
    return out;
  }

  get glyphs(): Glyph[] { return this.shows.flatMap((s) => s.glyphs); }

  /** Writes the (edited) operations back as the page's single content stream. */
  commit() {
    const stream = this.doc.context.flateStream(serialize(this.operations));
    this.page.node.set(PDFName.of('Contents'), this.doc.context.register(stream));
  }

  // MARK: edits

  /** Removes glyphs for which `remove` is true; every other glyph keeps its exact position. */
  removeGlyphs(remove: (g: Glyph) => boolean): number {
    const replacements = new Map<number, Op[]>();
    let count = 0;
    for (const show of this.shows) {
      const removed = show.glyphs.map(remove);
      const n = removed.filter(Boolean).length;
      if (!n) continue;
      count += n;
      const original = this.operations[show.opIndex];
      const unit = show.fontSize * show.hScale;
      if (!unit) continue;
      const elements: PDFValue[] = [];
      const gap = (d: number) => {
        const v = (-d * 1000) / unit;
        const last = elements[elements.length - 1];
        if (last?.t === 'num') last.v += v; else elements.push(num(v));
      };
      let chunk: number[] = [];
      const flush = () => { if (chunk.length) { elements.push({ t: 'str', v: Uint8Array.from(chunk) }); chunk = []; } };
      const source: PDFValue[] = original.op === 'TJ'
        ? (original.operands[0]?.t === 'arr' ? original.operands[0].v : [])
        : [original.operands[original.operands.length - 1] ?? { t: 'str', v: new Uint8Array() }];
      let g = 0;
      source.forEach((el, index) => {
        if (el.t === 'str') {
          while (g < show.glyphs.length && show.glyphs[g].element === index) {
            if (removed[g]) { flush(); gap(show.glyphs[g].displacement); } else chunk.push(...show.glyphs[g].bytes);
            g++;
          }
          flush();
        } else if (el.t === 'num') {
          flush();
          const last = elements[elements.length - 1];
          if (last?.t === 'num') last.v += el.v; else elements.push(num(el.v));
        }
      });
      const kept = elements.filter((e) => e.t !== 'num' || Math.abs(e.v) > 0.0001);
      const tj = op('TJ', [{ t: 'arr', v: kept }]);
      if (original.op === "'") replacements.set(show.opIndex, [op('T*'), tj]);
      else if (original.op === '"') replacements.set(show.opIndex, [op('Tw', [original.operands[0]]), op('Tc', [original.operands[1]]), op('T*'), tj]);
      else replacements.set(show.opIndex, [tj]);
    }
    if (!replacements.size) return 0;
    this.operations = this.operations.flatMap((o, i) => replacements.get(i) ?? [o]);
    this.analyze();
    return count;
  }

  /** Removes glyphs whose centre lies inside any of `rects`. */
  removeText(rects: Rect[]): number {
    return this.removeGlyphs((g) => rects.some((r) => contains(r, { x: g.rect.x + g.rect.w / 2, y: g.rect.y + g.rect.h / 2 })));
  }

  removeObject(o: GraphicObject) {
    if (o.opIndex < this.operations.length) { this.operations.splice(o.opIndex, 1); this.analyze(); }
  }

  /** Moves/scales an image or form so its bounds become `to`, lifting it out of any clipped group. */
  transformObject(o: GraphicObject, to: Rect) {
    const old = o.bounds, i = o.opIndex;
    if (old.w <= 0 || old.h <= 0 || i >= this.operations.length) return;
    const a = concat(concat([1, 0, 0, 1, -old.x, -old.y], [to.w / old.w, 0, 0, to.h / old.h, 0, 0]), [1, 0, 0, 1, to.x, to.y]);
    let at = i + 1;
    while (at < this.operations.length && this.depthAt[at] > 0) at++;
    const base = at < this.ctmAt.length ? this.ctmAt[at] : this.endCTM;
    const m = concat(concat(o.ctm, a), invert(base));
    const drawn = this.operations[i];
    this.operations.splice(at, 0, op('q'), op('cm', m.map(num)), drawn, op('Q'));
    this.operations.splice(i, 1);
    this.analyze();
  }

  /** Appends operations drawn last, on top (e.g. redaction boxes). */
  append(ops: Op[]) {
    this.operations.push(op('q'), ...ops, op('Q'));
    this.analyze();
  }

  /** The XObject stream behind an image, and whether its data is a JPEG as-is. */
  imageStream(o: GraphicObject): { stream: PDFRawStream; jpeg: boolean; width: number; height: number } | null {
    const xo = lookupDict(this.resources, 'XObject');
    const s = xo?.lookup(PDFName.of(o.name));
    if (!(s instanceof PDFRawStream)) return null;
    const f = s.dict.lookup(PDFName.of('Filter'));
    const filters = f instanceof PDFName ? [f.decodeText()] : f instanceof PDFArray ? f.asArray().map((x) => (x instanceof PDFName ? x.decodeText() : '')) : [];
    return { stream: s, jpeg: filters.length === 1 && filters[0] === 'DCTDecode', width: lookupNumber(s.dict, 'Width') ?? 0, height: lookupNumber(s.dict, 'Height') ?? 0 };
  }

  baseFont(resource: string): string { return this.font(resource)?.baseFont ?? ''; }

  /** The embedded TrueType/OpenType program of a font resource, if any. */
  fontProgram(resource: string): Uint8Array | null {
    let font = lookupDict(lookupDict(this.resources, 'Font'), resource);
    const desc = font?.lookup(PDFName.of('DescendantFonts'));
    if (desc instanceof PDFArray && desc.lookup(0) instanceof PDFDict) font = desc.lookup(0) as PDFDict;
    const d = lookupDict(font, 'FontDescriptor');
    const f2 = d?.lookup(PDFName.of('FontFile2'));
    if (f2 instanceof PDFStream) return streamBytes(f2);
    const f3 = d?.lookup(PDFName.of('FontFile3'));
    if (f3 instanceof PDFStream && lookupName(f3.dict, 'Subtype') === 'OpenType') return streamBytes(f3);
    return null;
  }

  // MARK: interpretation

  private font(name: string): FontMetrics | null {
    if (this.fonts.has(name)) return this.fonts.get(name)!;
    const f = lookupDict(lookupDict(this.resources, 'Font'), name);
    const m = f ? new FontMetrics(f) : null;
    this.fonts.set(name, m);
    return m;
  }

  private xobject(name: string): { dict: PDFDict; subtype: string } | null {
    const s = lookupDict(this.resources, 'XObject')?.lookup(PDFName.of(name));
    if (!(s instanceof PDFStream)) return null;
    return { dict: s.dict, subtype: lookupName(s.dict, 'Subtype') ?? '' };
  }

  private analyze() {
    this.shows = []; this.objects = []; this.rules = []; this.ruleColors = []; this.fills = []; this.shapes = []; this.depthAt = []; this.ctmAt = [];
    let gs: GState = { ctm: IDENTITY, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, fontName: '', fontSize: 0, rise: 0, fill: [0, 0, 0], stroke: [0, 0, 0], renderMode: 0, lineWidth: 1, clip: null };
    const stack: GState[] = [];
    let tm: Matrix = IDENTITY, tlm: Matrix = IDENTITY;
    // Each subpath's bounds, and whether it is an axis-aligned rectangle (only corner points, no curves).
    let subpaths: { r: Rect; box: boolean }[] = [];
    let current: Rect | null = null;
    let points: { x: number; y: number }[] = [], curved = false;
    const nums = (o: Op) => o.operands.filter((v) => v.t === 'num').map((v) => (v as { v: number }).v);
    const addPoint = (x: number, y: number) => {
      const p = applyToPoint(x, y, gs.ctm);
      current = union(current, { x: p.x, y: p.y, w: 0, h: 0 });
      points.push(p);
    };
    const close = () => {
      if (current) {
        const r = current;
        const corner = (p: { x: number; y: number }) => (Math.abs(p.x - r.x) < 0.5 || Math.abs(p.x - maxX(r)) < 0.5) && (Math.abs(p.y - r.y) < 0.5 || Math.abs(p.y - maxY(r)) < 0.5);
        subpaths.push({ r, box: !curved && points.length >= 4 && points.length <= 5 && points.every(corner) });
      }
      current = null; points = []; curved = false;
    };
    const pageArea = (() => { const m = this.page.getMediaBox(); return m.width * m.height; })();
    // Lines, and bars up to 6pt thick that are long and narrow (borders, accent stripes).
    const thin = (r: Rect) => (r.w < 2.5 && r.h > 4) || (r.h < 2.5 && r.w > 4) || (r.w < 6 && r.h > r.w * 4) || (r.h < 6 && r.w > r.h * 4);
    const clipTo = (r: Rect): Rect | null => {
      const c = gs.clip;
      if (!c) return r;
      const x0 = Math.max(r.x, c.x), y0 = Math.max(r.y, c.y), x1 = Math.min(maxX(r), maxX(c)), y1 = Math.min(maxY(r), maxY(c));
      return x1 >= x0 && y1 >= y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    };
    let clipping = false;
    const applyClip = () => {
      if (!clipping) return;
      clipping = false;
      const all = [...subpaths.map((s) => s.r), ...(current ? [current] : [])];
      if (!all.length) return;
      const b = all.reduce((a, r) => union(a, r)!);
      gs.clip = clipTo(b) ?? { x: b.x, y: b.y, w: 0, h: 0 };
    };
    const paint = (stroke: boolean, fill: boolean) => {
      applyClip();
      close();
      // What shows is the shape cut to the clipping area (borders are often a full box clipped to one side).
      subpaths = subpaths.flatMap((s) => { const c = clipTo(s.r); return c ? [{ r: c, box: s.box || (c.w < s.r.w - 0.5 || c.h < s.r.h - 0.5) }] : []; });
      const ink = (stroke ? gs.stroke : gs.fill) ?? [0, 0, 0];
      const rule = (r: Rect) => { this.rules.push(r); this.ruleColors.push(ink); };
      for (const { r, box } of subpaths) {
        if (thin(r)) { rule(r); continue; }
        if (r.w >= 8 && r.h >= 8 && r.w * r.h < pageArea * 0.85) {
          this.shapes.push({ rect: r, fill: fill && gs.fill ? gs.fill : undefined, stroke: stroke && gs.stroke ? gs.stroke : undefined,
            lineWidth: gs.lineWidth * Math.hypot(gs.ctm[0], gs.ctm[1]), rounded: !box });
        }
        if (!box) continue;
        if (stroke) [rect(r.x, r.y, r.w, 0), rect(r.x, maxY(r), r.w, 0), rect(r.x, r.y, 0, r.h), rect(maxX(r), r.y, 0, r.h)].forEach(rule);
        if (fill && gs.fill && r.w * r.h < pageArea * 0.85) this.fills.push({ rect: r, color: gs.fill });
      }
      subpaths = [];
    };

    const show = (elements: PDFValue[], opIndex: number) => {
      const metrics = this.font(gs.fontName);
      if (!metrics) return;
      const glyphs: Glyph[] = [];
      const fs = gs.fontSize, th = gs.hScale;
      elements.forEach((el, index) => {
        if (el.t === 'str') {
          const bytes = el.v;
          for (let k = 0; k < bytes.length;) {
            const n = Math.min(metrics.bytesPerCode, bytes.length - k);
            let code = 0;
            for (let q = 0; q < n; q++) code = (code << 8) | bytes[k + q];
            const w0 = metrics.width(code);
            let tx = w0 * fs + gs.charSpacing;
            if (n === 1 && code === 32) tx += gs.wordSpacing;
            tx *= th;
            const toUser = concat(tm, gs.ctm);
            const local = rect(0, metrics.descent * fs + gs.rise, Math.max(w0 * fs * th, 0.01), (metrics.ascent - metrics.descent) * fs);
            const upright = Math.abs(toUser[1]) < 0.001 && Math.abs(toUser[2]) < 0.001 && toUser[0] > 0 && toUser[3] > 0;
            glyphs.push({
              element: index, bytes: bytes.slice(k, k + n), rect: applyToRect(local, toUser), displacement: tx,
              origin: applyToPoint(0, gs.rise, toUser), size: fs * Math.hypot(toUser[2], toUser[3]), upright,
              fontResource: gs.fontName, color: gs.fill, invisible: gs.renderMode === 3 || gs.renderMode === 7,
            });
            tm = concat([1, 0, 0, 1, tx, 0], tm);
            k += n;
          }
        } else if (el.t === 'num') {
          tm = concat([1, 0, 0, 1, (-el.v / 1000) * fs * th, 0], tm);
        }
      });
      this.shows.push({ opIndex, glyphs, fontSize: fs, hScale: th, fontResource: gs.fontName, baseFont: metrics.baseFont });
    };
    const nextLine = () => { tlm = concat([1, 0, 0, 1, 0, -gs.leading], tlm); tm = tlm; };
    const color = (n: number[]): [number, number, number] | null =>
      n.length === 1 ? [n[0], n[0], n[0]] : n.length === 3 ? [n[0], n[1], n[2]]
        : n.length === 4 ? [(1 - n[0]) * (1 - n[3]), (1 - n[1]) * (1 - n[3]), (1 - n[2]) * (1 - n[3])] : null;

    this.operations.forEach((o, index) => {
      this.depthAt.push(stack.length);
      this.ctmAt.push(gs.ctm);
      const n = nums(o);
      switch (o.op) {
        case 'g': case 'rg': case 'k': case 'sc': case 'scn': gs.fill = color(n); break;
        case 'cs': gs.fill = [0, 0, 0]; break;
        case 'G': case 'RG': case 'K': case 'SC': case 'SCN': gs.stroke = color(n); break;
        case 'CS': gs.stroke = [0, 0, 0]; break;
        case 'w': gs.lineWidth = n[0] ?? 1; break;
        case 'q': stack.push({ ...gs }); break;
        case 'Q': if (stack.length) gs = stack.pop()!; break;
        case 'cm': if (n.length === 6) gs.ctm = concat(n as Matrix, gs.ctm); break;
        case 'BT': tm = IDENTITY; tlm = IDENTITY; break;
        case 'Tc': gs.charSpacing = n[0] ?? 0; break;
        case 'Tw': gs.wordSpacing = n[0] ?? 0; break;
        case 'Tz': gs.hScale = (n[0] ?? 100) / 100; break;
        case 'TL': gs.leading = n[0] ?? 0; break;
        case 'Ts': gs.rise = n[0] ?? 0; break;
        case 'Tr': gs.renderMode = n[0] ?? 0; break;
        case 'Tf': {
          const f = o.operands[0];
          if (f?.t === 'name') gs.fontName = f.v;
          gs.fontSize = n[n.length - 1] ?? gs.fontSize;
          break;
        }
        case 'Td': case 'TD':
          if (n.length === 2) { if (o.op === 'TD') gs.leading = -n[1]; tlm = concat([1, 0, 0, 1, n[0], n[1]], tlm); tm = tlm; }
          break;
        case 'Tm': if (n.length === 6) { tm = n as Matrix; tlm = tm; } break;
        case 'T*': nextLine(); break;
        case 'Tj': { const s = o.operands[o.operands.length - 1]; if (s) show([s], index); break; }
        case 'TJ': { const a = o.operands[0]; if (a?.t === 'arr') show(a.v, index); break; }
        case "'": { nextLine(); const s = o.operands[o.operands.length - 1]; if (s) show([s], index); break; }
        case '"': {
          if (n.length >= 2) { gs.wordSpacing = n[0]; gs.charSpacing = n[1]; }
          nextLine();
          const s = o.operands[o.operands.length - 1];
          if (s) show([s], index);
          break;
        }
        case 'm': close(); if (n.length >= 2) addPoint(n[0], n[1]); break;
        case 'l': if (n.length >= 2) addPoint(n[0], n[1]); break;
        case 're':
          close();
          if (n.length === 4) { addPoint(n[0], n[1]); addPoint(n[0] + n[2], n[1]); addPoint(n[0] + n[2], n[1] + n[3]); addPoint(n[0], n[1] + n[3]); close(); }
          break;
        case 'c': case 'v': case 'y': curved = true; if (n.length >= 2) addPoint(n[n.length - 2], n[n.length - 1]); break;
        case 'h': break;
        case 'S': case 's': paint(true, false); break;
        case 'f': case 'F': case 'f*': paint(false, true); break;
        case 'B': case 'B*': case 'b': case 'b*': paint(true, true); break;
        case 'W': case 'W*': clipping = true; break;
        case 'n': applyClip(); current = null; points = []; curved = false; subpaths = []; break;
        case 'Do': {
          const nm = o.operands[0];
          if (nm?.t !== 'name') break;
          const x = this.xobject(nm.v);
          if (!x) break;
          if (x.subtype === 'Image') this.objects.push({ kind: 'image', opIndex: index, name: nm.v, ctm: gs.ctm, bounds: applyToRect(rect(0, 0, 1, 1), gs.ctm) });
          else if (x.subtype === 'Form') {
            const bb = x.dict.lookup(PDFName.of('BBox'));
            let box = rect(0, 0, 1, 1);
            if (bb instanceof PDFArray && bb.size() === 4) {
              const v = bb.asArray().map((e) => (e instanceof PDFNumber ? e.asNumber() : 0));
              box = rect(Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.abs(v[2] - v[0]), Math.abs(v[3] - v[1]));
            }
            const mt = x.dict.lookup(PDFName.of('Matrix'));
            const matrix: Matrix = mt instanceof PDFArray && mt.size() === 6 ? (mt.asArray().map((e) => (e instanceof PDFNumber ? e.asNumber() : 0)) as Matrix) : IDENTITY;
            this.objects.push({ kind: 'form', opIndex: index, name: nm.v, ctm: gs.ctm, bounds: applyToRect(box, concat(matrix, gs.ctm)) });
          }
          break;
        }
        case 'BI':
          this.objects.push({ kind: 'inline', opIndex: index, name: 'inline', ctm: gs.ctm, bounds: applyToRect(rect(0, 0, 1, 1), gs.ctm) });
          break;
      }
    });
    this.endCTM = gs.ctm;
  }

  /** A copy of the operations that draws only `o` (to render an image on its own). */
  isolatedOps(o: GraphicObject): Op[] {
    return [op('q'), op('cm', o.ctm.map(num)), this.operations[o.opIndex], op('Q')];
  }
}

export { serializeOp, PDFRef, PDFString, PDFHexString };
