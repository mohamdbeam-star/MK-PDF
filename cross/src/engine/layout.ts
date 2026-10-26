// Structured reading of a page — paragraphs of styled runs, tables and images in reading order — from
// glyph positions (engine) and Unicode text (pdf.js text items). Drives every export and the text editor.
// Port of LayoutModel.swift.
import type { PDFDocument } from 'pdf-lib';
import { Glyph, GraphicObject, PageContent, Rect, contains, intersects, isSpace, maxX, maxY, rect, union } from './pageContent';
import { Grid, GridCell, findGrids } from './tables';

export interface TextItem { str: string; x: number; y: number; w: number; h: number; rtl: boolean }
/** Where a page's Unicode text comes from: pdf.js text items, or a lookup by rect (PDFKit in the Mac app). */
export type PageText = TextItem[] | { textIn(r: Rect): string };

export interface LayoutFont { family: string; postScript: string; bold: boolean; italic: boolean; mono: boolean }
export interface LayoutRun {
  text: string; font: LayoutFont; size: number; color: [number, number, number]; invisible: boolean; resource: string;
  /** Raised (superscript, > 0) or lowered (subscript, < 0) from the line's baseline, in points. */
  rise?: number;
}
export interface LayoutLine { rect: Rect; baseline: number; runs: LayoutRun[]; parts: LayoutLine[]; tabStops: number[]; hardBreak?: boolean }
export interface LayoutParagraph {
  kind: 'paragraph'; rect: Rect; lines: LayoutLine[]; alignment: 'left' | 'center' | 'right' | 'justify'; rtl: boolean; pitch: number;
  /** A coloured bar or box drawn behind the paragraph (e.g. a footer band). */
  backdrop?: { rect: Rect; color: [number, number, number] };
  /** Sits on top of a picture (keeps light text light). */
  onImage?: boolean;
}
export interface LayoutCell extends GridCell {
  lines: LayoutLine[];
  alignment: 'left' | 'center' | 'right';
  valign: 'top' | 'center' | 'bottom';
  rtl: boolean;
  pitch: number;
}
export interface LayoutTable {
  kind: 'table'; rect: Rect;
  /** Column left edges and the right edge (legacy grid view). */
  columns: number[]; right: number;
  colEdges: number[]; rowEdges: number[];
  cells: LayoutCell[];
  /** One line per cell on a rows × columns grid (merged cells only in their first slot). */
  rows: (LayoutLine | null)[][];
  rowRects: Rect[];
  bordered: boolean;
  /** Built from drawn rules (exact cells), rather than inferred from text alignment. */
  ruled: boolean;
  borderColor?: [number, number, number];
}
export interface LayoutImage { kind: 'image'; rect: Rect; object: GraphicObject; data?: Uint8Array; ext?: 'jpeg' | 'png' }
export type LayoutItem = LayoutParagraph | LayoutTable | LayoutImage;

export interface PageLayout {
  index: number;
  width: number; height: number;   // display size
  crop: Rect;
  rotation: number;
  items: LayoutItem[];
  /** Free-standing horizontal lines (dividers under headings, signature lines), page space. */
  rules: { rect: Rect; color: [number, number, number] }[];
}

export const lineText = (l: LayoutLine) => l.runs.map((r) => r.text).join('');
export const lineSize = (l: LayoutLine) => Math.max(...l.runs.map((r) => r.size), 1);
export const pieces = (l: LayoutLine) => (l.parts.length ? l.parts : [l]);

export function isRTL(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x0590 && c <= 0x08ff) || (c >= 0xfb1d && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)) return true;
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) return false;
  }
  return false;
}

export function paragraphRuns(p: LayoutParagraph): LayoutRun[] {
  const out: LayoutRun[] = [];
  p.lines.forEach((line, i) => {
    const runs = line.runs.map((r) => ({ ...r }));
    if (i < p.lines.length - 1 && runs.length) {
      const last = runs[runs.length - 1];
      if (line.hardBreak) last.text = last.text.replace(/ +$/, '') + '\n';
      else if (last.text.endsWith('-')) last.text = last.text.slice(0, -1); else if (!last.text.endsWith(' ')) last.text += ' ';
    }
    out.push(...runs);
  });
  const merged: LayoutRun[] = [];
  for (const r of out) {
    const l = merged[merged.length - 1];
    if (l && sameFont(l.font, r.font) && Math.abs(l.size - r.size) < 0.25 && l.color.join() === r.color.join() && l.invisible === r.invisible && (l.rise ?? 0) === (r.rise ?? 0)) l.text += r.text;
    else merged.push(r);
  }
  return merged;
}
export const paragraphText = (p: LayoutParagraph) => paragraphRuns(p).map((r) => r.text).join('');
const sameFont = (a: LayoutFont, b: LayoutFont) => a.family === b.family && a.bold === b.bold && a.italic === b.italic;

export function layoutFont(baseFont: string): LayoutFont {
  const name = baseFont.split('+').pop() || baseFont || 'Helvetica';
  const lower = name.toLowerCase();
  const bold = ['bold', 'black', 'heavy', 'semibold', 'demi'].some((k) => lower.includes(k));
  const italic = lower.includes('italic') || lower.includes('oblique');
  const mono = ['courier', 'mono', 'consol'].some((k) => lower.includes(k));
  const known: Record<string, string> = {
    arialmt: 'Arial', arial: 'Arial', timesnewromanps: 'Times New Roman', timesnewroman: 'Times New Roman', times: 'Times New Roman',
    couriernewps: 'Courier New', couriernew: 'Courier New', courier: 'Courier New', helvetica: 'Helvetica', helveticaneue: 'Helvetica Neue',
    symbolmt: 'Symbol', georgia: 'Georgia', verdana: 'Verdana', tahoma: 'Tahoma', calibri: 'Calibri', cambria: 'Cambria', segoeui: 'Segoe UI',
    timesroman: 'Times New Roman',
  };
  let stem = name.split(/[-,]/)[0];
  for (const suffix of ['PSMT', 'MT', 'PS']) if (stem.endsWith(suffix)) stem = stem.slice(0, -suffix.length);
  let family = known[stem.toLowerCase()];
  if (!family) family = stem.replace(/([a-z])([A-Z])/g, '$1 $2') || 'Helvetica';
  return { family, postScript: name, bold, italic, mono };
}

/** Text items sorted by height on the page, for fast lookups by rect. */
export interface TextIndex { items: TextItem[]; maxH: number }
export function indexText(items: TextItem[]): TextIndex {
  return { items: [...items].sort((a, b) => a.y - b.y), maxH: Math.max(0, ...items.map((i) => i.h)) };
}

/** Text from pdf.js items covering a page-space rect (items are sliced proportionally at the edges). */
export function textIn(source: TextItem[] | TextIndex, r: Rect): string {
  const index = Array.isArray(source) ? indexText(source) : source;
  const list = index.items, lowY = r.y - index.maxH * 0.35;
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].y < lowY) lo = mid + 1; else hi = mid; }
  const hits: TextItem[] = [];
  for (let k = lo; k < list.length && list[k].y <= maxY(r); k++) {
    const it = list[k];
    if (it.y >= r.y - it.h * 0.35 && it.x < maxX(r) && it.x + it.w > r.x && it.str.length) hits.push(it);
  }
  hits.sort((a, b) => a.x - b.x);
  let out = '';
  let lastEnd: number | null = null;
  for (const it of hits) {
    const cw = it.w / it.str.length || 1;
    const from = Math.max(0, Math.round((r.x - it.x) / cw));
    const to = Math.min(it.str.length, Math.round((maxX(r) - it.x) / cw));
    let s = it.rtl || to - from > it.str.length * 0.8 ? it.str : it.str.slice(from, to);
    if (it.rtl && (from > 0 || to < it.str.length) && to - from < it.str.length * 0.8) {
      const n = it.str.length;
      s = it.str.slice(n - to, n - from);
    }
    if (lastEnd !== null && it.x - lastEnd > it.h * 0.2 && !out.endsWith(' ') && !s.startsWith(' ')) out += ' ';
    out += s;
    lastEnd = it.x + it.w;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Extracts the layout of page `index`. `items` are pdf.js text items in page space. */
export function layoutPage(doc: PDFDocument, index: number, items: PageText, content?: PageContent): PageLayout {
  const page = doc.getPage(index);
  const pc = content ?? new PageContent(doc, page);
  const crop = page.getCropBox();
  const cropR = rect(crop.x, crop.y, crop.width, crop.height);
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const swap = rotation % 180 !== 0;
  const glyphs = pc.glyphs.filter((g) => g.upright && g.size > 0.5 && g.rect.w > 0.01);
  const center = (g: Glyph) => ({ x: g.rect.x + g.rect.w / 2, y: g.rect.y + g.rect.h / 2 });
  const text = Array.isArray(items) ? indexText(items) : null;
  const lookup = (r: Rect) => (text ? textIn(text, r) : (items as { textIn(r: Rect): string }).textIn(r).replace(/\s+/g, ' ').trim());

  const toLine = (s: Glyph[]): LayoutLine | null => {
    const visible = s.filter((g) => !isSpace(g));
    if (!visible.length) return null;
    const r = visible.reduce<Rect | null>((a, g) => union(a, g.rect), null)!;
    const str = lookup({ x: r.x - 0.3, y: r.y + r.h * 0.15, w: r.w + 0.6, h: r.h * 0.7 });
    if (!str) return null;
    const big = Math.max(...visible.map((g) => g.size));
    const baseline = visible.find((g) => g.size >= big * 0.95)!.origin.y;
    type Style = { res: string; size: number; color: string; invisible: boolean; rise: number };
    const style = (g: Glyph): Style => {
      const d = g.origin.y - baseline;
      return { res: g.fontResource, size: Math.round(g.size * 4), color: (g.color ?? [0, 0, 0]).join(), invisible: g.invisible, rise: Math.abs(d) > big * 0.08 ? Math.round(d * 2) / 2 : 0 };
    };
    const groups: [Style, number, Glyph][] = [];
    for (const g of visible) {
      const st = style(g), l = groups[groups.length - 1];
      if (l && l[0].res === st.res && l[0].size === st.size && l[0].color === st.color && l[0].invisible === st.invisible && l[0].rise === st.rise) l[1]++;
      else groups.push([st, 1, g]);
    }
    const run = (st: Style, g: Glyph, t: string): LayoutRun => ({
      text: t, font: layoutFont(pc.baseFont(st.res)), size: st.size / 4, color: (g.color ?? [0, 0, 0]) as [number, number, number],
      invisible: st.invisible, resource: st.res, ...(st.rise ? { rise: st.rise } : {}),
    });
    const chars = Array.from(str);
    let runs: LayoutRun[];
    if (groups.length > 1 && chars.filter((c) => c.trim()).length === visible.length) {
      runs = [];
      let gi = 0, used = 0, cur = '';
      for (const ch of chars) {
        cur += ch;
        if (!ch.trim()) continue;
        if (++used === groups[gi][1] && gi < groups.length - 1) { runs.push(run(groups[gi][0], groups[gi][2], cur)); cur = ''; gi++; used = 0; }
      }
      runs.push(run(groups[gi][0], groups[gi][2], cur));
    } else {
      const dominant = groups.reduce((a, b) => (b[1] > a[1] ? b : a));
      runs = [run(dominant[0], dominant[2], str)];
    }
    return { rect: r, baseline, runs, parts: [], tabStops: [] };
  };

  // 1. Ruled tables take the text inside their cells.
  const out: LayoutItem[] = [];
  const grids = findGrids(pc.rules, pc.ruleColors, pc.fills, cropR);
  const inGrid = new Set<Glyph>();
  for (const grid of grids) {
    const own = glyphs.filter((g) => contains(grid.rect, center(g)));
    if (!own.length && grid.cells.length < 4) continue;
    own.forEach((g) => inGrid.add(g));
    const cells: LayoutCell[] = grid.cells.map((c) => {
      const mine = own.filter((g) => contains(c.rect, center(g)));
      // Within a cell every baseline is one line, whatever the gaps between words.
      const lines = segmentRows(mine).map((row) => toLine(row.flat())).filter((l): l is LayoutLine => !!l);
      return cellFrom(c, lines);
    });
    out.push(tableFrom(grid, cells));
  }

  // 2. Remaining rows by baseline, split into segments at column-sized gaps or runs of 3+ spaces.
  const rows = segmentRows(glyphs.filter((g) => !inGrid.has(g)));
  const lineRows = rows.map((r) => r.map(toLine).filter((l): l is LayoutLine => !!l)).filter((r) => r.length);

  // 3. Unruled tables: two or more consecutive rows with two or more segments.
  let free: LayoutLine[] = [];
  for (let i = 0; i < lineRows.length;) {
    let j = i;
    while (j < lineRows.length && lineRows[j].length >= 2 && (j === i || Math.abs(lineRows[j - 1][0].baseline - lineRows[j][0].baseline) < lineSize(lineRows[j][0]) * 3.2)) j++;
    if (j - i >= 2) {
      const t = buildTable(lineRows.slice(i, j));
      // Wrapped cell text: following one-segment rows aligned with a column join that cell.
      while (j < lineRows.length && lineRows[j].length === 1) {
        const l = lineRows[j][0];
        const prev = lineRows[j - 1][0];
        const col = t.columns.map((c, k) => [c, k] as const).filter(([c]) => c <= l.rect.x + 8).pop()?.[1];
        if (col === undefined || prev.baseline - l.baseline >= lineSize(l) * 1.7 || (col === 0 && Math.abs(l.rect.x - t.columns[0]) >= 8)) break;
        const cell = t.cells.find((c) => c.row === t.rowRects.length - 1 && c.col === col);
        if (cell) { cell.lines.push(l); cell.rect = union(cell.rect, l.rect); }
        t.rect = union(t.rect, l.rect);
        j++;
      }
      const zone = { x: t.rect.x - 6, y: t.rect.y - 8, w: t.rect.w + 12, h: t.rect.h + 16 };
      t.bordered = pc.rules.filter((r) => intersects(zone, r) && r.w > r.h).length >= 2;
      t.rows = legacyRows(t.cells, t.rowRects.length, t.columns.length);
      out.push(t);
      i = j;
    } else { free.push(...lineRows[i]); i++; }
  }

  // 4. Paragraphs. Pieces on one baseline become a single tabbed line.
  free.sort((a, b) => (Math.abs(a.baseline - b.baseline) > Math.max(1.5, Math.max(lineSize(a), lineSize(b)) * 0.3) ? b.baseline - a.baseline : a.rect.x - b.rect.x));
  const joined: LayoutLine[] = [];
  for (const l of free) {
    const last = joined[joined.length - 1];
    const tolerance = Math.max(1.5, Math.max(lineSize(l), lineSize(last ?? l)) * 0.3);
    if (last && Math.abs(last.baseline - l.baseline) < tolerance && l.rect.x > maxX(last.rect) && isRTL(lineText(l)) === isRTL(lineText(last))) {
      if (!last.parts.length) last.parts = [{ ...last, parts: [], tabStops: [] }];
      last.parts.push(l);
      last.tabStops.push(l.rect.x);
      last.runs = [...last.runs, { ...l.runs[0], text: '\t' }, ...l.runs];
      last.rect = union(last.rect, l.rect);
    } else joined.push({ ...l });
  }
  free = joined;
  const groups: LayoutLine[][] = [];
  for (const l of free) {
    const size = lineSize(l), rtl = isRTL(lineText(l));
    let target = -1;
    if (!isListStart(lineText(l))) {
      for (let gi = groups.length - 1; gi >= 0; gi--) {
        const g = groups[gi], last = g[g.length - 1];
        const pitch = last.baseline - l.baseline;
        const sameSize = Math.abs(size - lineSize(last)) < Math.max(size, lineSize(last)) * 0.18;
        const spacing = pitch > size * 0.8 && pitch < size * 1.9;
        const steady = g.length < 2 || Math.abs(pitch - (g[g.length - 2].baseline - last.baseline)) < size * 0.35;
        const overlap = Math.min(maxX(l.rect), maxX(last.rect)) - Math.max(l.rect.x, last.rect.x) > 0;
        const aligned = Math.abs(l.rect.x - g[Math.min(1, g.length - 1)].rect.x) < size * 3 || Math.abs((l.rect.x + maxX(l.rect)) / 2 - (last.rect.x + maxX(last.rect)) / 2) < size;
        // Lines in different scripts (an English and an Arabic footer line) stay separate paragraphs.
        if (sameSize && spacing && steady && overlap && aligned && isRTL(lineText(last)) === rtl && !last.parts.length && !l.parts.length) { target = gi; break; }
      }
    }
    if (target >= 0) groups[target].push(l); else groups.push([l]);
  }
  for (const g of groups) {
    const r = g.reduce<Rect | null>((a, l) => union(a, l.rect), null)!;
    const text = g.map(lineText).join(' ');
    const rtl = isRTL(text);
    let alignment = alignmentOf(g, r, rtl);
    if (g.length === 1 && Math.abs(r.x + r.w / 2 - (cropR.x + cropR.w / 2)) < 6 && r.x - cropR.x > 90 && !g[0].parts.length) alignment = 'center';
    // Centred lines (titles, addresses) are always broken where the author broke them.
    if (alignment === 'center') g.slice(0, -1).forEach((l) => (l.hardBreak = true)); else markBreaks(g, r, alignment);
    const pitch = g.length > 1 ? g[0].baseline - g[1].baseline : lineSize(g[0]) * 1.2;
    const behind = [...pc.fills].reverse().find((f) => f.rect.w > r.w * 0.9 && f.rect.x <= r.x + 1 && maxX(f.rect) >= maxX(r) - 1 && f.rect.y <= r.y + 1 && maxY(f.rect) >= maxY(r) - 1
      && f.rect.h < Math.max(r.h * 8, 80) && !f.color.every((c) => c > 0.97));
    const onImage = pc.objects.some((o) => o.kind !== 'form' && o.bounds.x <= r.x + 1 && maxX(o.bounds) >= maxX(r) - 1 && o.bounds.y <= r.y + 1 && maxY(o.bounds) >= maxY(r) - 1);
    out.push({ kind: 'paragraph', rect: r, lines: g, alignment, rtl, pitch, ...(behind ? { backdrop: { rect: behind.rect, color: behind.color } } : {}), ...(onImage ? { onImage } : {}) });
  }

  // 5. Images (skipping full-page backgrounds behind real text, e.g. OCR'd scans).
  const hasText = glyphs.length > 0;
  for (const o of pc.objects) {
    if (o.kind === 'form' || o.bounds.w <= 4 || o.bounds.h <= 4 || !intersects(o.bounds, cropR)) continue;
    if (hasText && o.bounds.w * o.bounds.h > cropR.w * cropR.h * 0.8) continue;
    out.push({ kind: 'image', rect: o.bounds, object: o });
  }

  // 6. Divider lines: long horizontal rules outside tables that don't underline text.
  const dividers: PageLayout['rules'] = [];
  pc.rules.forEach((r, k) => {
    if (r.w < 30 || r.h > 3 || r.w < r.h * 8) return;
    if (grids.some((g) => r.y >= g.rect.y - 3 && r.y <= maxY(g.rect) + 3 && r.x >= g.rect.x - 3 && maxX(r) <= maxX(g.rect) + 3)) return;
    const under = glyphs.filter((g) => { const d = g.origin.y - (r.y + r.h / 2); return d >= -1 && d <= g.size * 0.4 && g.rect.x < maxX(r) && maxX(g.rect) > r.x; });
    if (under.reduce((a, g) => a + g.rect.w, 0) > r.w * 0.3) return;
    if (dividers.some((d) => Math.abs(d.rect.y - r.y) < 1.5 && d.rect.x < maxX(r) && maxX(d.rect) > r.x)) return;
    dividers.push({ rect: r, color: pc.ruleColors[k] ?? [0, 0, 0] });
  });

  const layout: PageLayout = { index, width: swap ? cropR.h : cropR.w, height: swap ? cropR.w : cropR.h, crop: cropR, rotation, items: [], rules: dividers };
  layout.items = out.sort((a, b) => {
    const ra = topLeft(layout, a.rect), rb = topLeft(layout, b.rect);
    return Math.abs(ra.y - rb.y) > 4 ? ra.y - rb.y : ra.x - rb.x;
  });
  return layout;
}

const isListStart = (t: string) => /^[•●▪◦‣–—\-*]/.test(t) || /^(\(?[0-9]{1,3}[.)]|\(?[a-zA-Z][.)]|[ivxIVX]{1,4}[.)])\s/.test(t);

/** Glyphs → rows (one per baseline, top to bottom) of segments split at column-sized gaps or 3+ spaces. */
function segmentRows(glyphs: Glyph[]): Glyph[][][] {
  const sorted = [...glyphs].sort((a, b) => (Math.abs(a.origin.y - b.origin.y) > Math.max(1, a.size * 0.3) ? b.origin.y - a.origin.y : a.rect.x - b.rect.x));
  const rows: Glyph[][][] = [];
  let row: Glyph[][] = [], seg: Glyph[] = [], baseline: number | null = null, spaces = 0;
  const endSeg = () => {
    while (seg.length && isSpace(seg[seg.length - 1])) seg.pop();
    while (seg.length && isSpace(seg[0])) seg.shift();
    if (seg.length) row.push(seg);
    seg = [];
  };
  const endRow = () => { endSeg(); if (row.length) rows.push(row); row = []; };
  for (const g of sorted) {
    if (baseline !== null && Math.abs(g.origin.y - baseline) > Math.max(1, g.size * 0.3)) { endRow(); baseline = null; spaces = 0; }
    if (baseline === null) baseline = g.origin.y;
    if (isSpace(g)) { spaces++; if (spaces === 3) endSeg(); if (seg.length) seg.push(g); continue; }
    const last = [...seg].reverse().find((x) => !isSpace(x));
    if (last && g.rect.x - maxX(last.rect) > Math.max(g.size, last.size) * 1.6) endSeg();
    spaces = 0;
    seg.push(g);
  }
  endRow();
  return attachScripts(rows);
}

/** Folds superscript/subscript rows (smaller text a little above or below a line, touching it) into that line. */
function attachScripts(rows: Glyph[][][]): Glyph[][][] {
  const baseOf = (gs: Glyph[]) => { const big = Math.max(...gs.map((g) => g.size)); return gs.find((g) => g.size >= big * 0.95 && !isSpace(g))?.origin.y ?? gs[0].origin.y; };
  for (let i = 0; i < rows.length; i++) {
    const small = rows[i].flat().filter((g) => !isSpace(g));
    if (!small.length) continue;
    const size = Math.max(...small.map((g) => g.size)), base = baseOf(small);
    for (const j of [i + 1, i - 1]) {
      if (j < 0 || j >= rows.length) continue;
      const main = rows[j].flat().filter((g) => !isSpace(g));
      if (!main.length) continue;
      const mSize = Math.max(...main.map((g) => g.size)), mBase = baseOf(main);
      if (size > mSize * 0.85) continue;
      const d = base - mBase;
      if (!((d > mSize * 0.12 && d < mSize * 0.7) || (d < -mSize * 0.08 && d > -mSize * 0.45))) continue;
      const host = (seg: Glyph[]) => {
        const x0 = seg[0].rect.x, x1 = maxX(seg[seg.length - 1].rect);
        return rows[j].find((ms) => ms.some((m) => !isSpace(m) && ((x0 - maxX(m.rect) > -1.5 && x0 - maxX(m.rect) < mSize * 0.5) || (m.rect.x - x1 > -1.5 && m.rect.x - x1 < mSize * 0.3))));
      };
      if (!rows[i].every((seg) => host(seg))) continue;
      for (const seg of rows[i]) { const h = host(seg)!; h.push(...seg); h.sort((a, b) => a.rect.x - b.rect.x); }
      rows.splice(i, 1);
      i--;
      break;
    }
  }
  return rows;
}

function alignmentOf(g: LayoutLine[], r: Rect, rtl: boolean, box?: Rect): LayoutParagraph['alignment'] {
  const frame = box ?? r, mid = frame.x + frame.w / 2;
  const lefts = g.map((l) => l.rect.x), rights = g.map((l) => maxX(l.rect));
  if (box) {
    // Inside a cell: judge against the cell edges.
    const pad = Math.min(8, box.w * 0.1);
    const centered = g.every((l) => Math.abs(l.rect.x + l.rect.w / 2 - mid) < Math.max(3, box.w * 0.04));
    const nearLeft = lefts.every((x) => x - box.x < pad + 2), nearRight = rights.every((x) => maxX(box) - x < pad + 2);
    if (centered && !(nearLeft && nearRight) && !(nearLeft && !rtl)) return 'center';
    if (nearRight && !nearLeft) return 'right';
    return rtl ? 'right' : 'left';
  }
  if (g.length < 2) return rtl ? 'right' : 'left';
  const leftAligned = lefts.every((x) => Math.abs(x - lefts[0]) < 2);
  const rightAligned = rights.slice(0, -1).every((x) => Math.abs(x - rights[0]) < 2.5);
  if (!leftAligned && g.every((l) => Math.abs(l.rect.x + l.rect.w / 2 - mid) < 3)) return 'center';
  if (leftAligned && rightAligned && g.length > 2) return 'justify';
  if (!leftAligned && rights.every((x) => Math.abs(x - rights[0]) < 2)) return 'right';
  return rtl ? 'right' : 'left';
}

/** Marks lines the author ended early (the next line's first word would have fitted), so they stay broken. */
function markBreaks(g: LayoutLine[], r: Rect, alignment: LayoutParagraph['alignment']) {
  for (let i = 0; i < g.length - 1; i++) {
    const next = lineText(g[i + 1]).trim();
    const chars = Math.max(1, next.length);
    const word = next.split(/\s+/)[0] ?? '';
    const wordW = (g[i + 1].rect.w / chars) * (word.length + 1);
    const room = alignment === 'justify' ? 0 : r.w - g[i].rect.w;
    g[i].hardBreak = room > wordW * 1.05 || /[:;]$/.test(lineText(g[i]).trim()) && room > wordW * 0.5;
  }
}

function cellFrom(c: GridCell, lines: LayoutLine[]): LayoutCell {
  const text = lines.map(lineText).join(' ');
  const rtl = isRTL(text);
  const content = lines.reduce<Rect | null>((a, l) => union(a, l.rect), null);
  const alignment = content ? (alignmentOf(lines, content, rtl, c.rect) as LayoutCell['alignment']) : 'left';
  let valign: LayoutCell['valign'] = 'top';
  if (content) {
    const top = maxY(c.rect) - maxY(content), bottom = content.y - c.rect.y;
    if (Math.abs(top - bottom) < Math.max(3, c.rect.h * 0.12) && top > 4) valign = 'center';
    else if (bottom < top * 0.5 && top > 8) valign = 'bottom';
  }
  if (content && lines.length > 1) markBreaks(lines, { ...content, w: Math.max(content.w, c.rect.w - 6) }, alignment);
  const pitch = lines.length > 1 ? lines[0].baseline - lines[1].baseline : lines.length ? lineSize(lines[0]) * 1.2 : 12;
  return { ...c, lines, alignment, valign, rtl, pitch };
}

function tableFrom(grid: Grid, cells: LayoutCell[]): LayoutTable {
  const rows = grid.rowEdges.length - 1, cols = grid.colEdges.length - 1;
  const rowRects = grid.rowEdges.slice(0, -1).map((top, i) => rect(grid.rect.x, grid.rowEdges[i + 1], grid.rect.w, top - grid.rowEdges[i + 1]));
  return {
    kind: 'table', rect: grid.rect, columns: grid.colEdges.slice(0, -1), right: grid.colEdges[cols], colEdges: grid.colEdges, rowEdges: grid.rowEdges,
    cells, rowRects, bordered: cells.some((c) => c.borders.top || c.borders.left), ruled: true, rows: legacyRows(cells, rows, cols), borderColor: grid.borderColor,
  };
}

/** Rows × columns of single lines (a cell's lines joined), for writers that only need a plain grid. */
function legacyRows(cells: LayoutCell[], rows: number, cols: number): (LayoutLine | null)[][] {
  const grid: (LayoutLine | null)[][] = Array.from({ length: rows }, () => Array<LayoutLine | null>(cols).fill(null));
  for (const c of cells) {
    if (!c.lines.length || !grid[c.row]) continue;
    const first = c.lines[0];
    const runs = c.lines.flatMap((l, i) => (i ? [{ ...l.runs[0], text: ' ' }, ...l.runs] : l.runs));
    grid[c.row][c.col] = { ...first, rect: c.lines.reduce<Rect>((a, l) => union(a, l.rect)!, first.rect), runs, parts: [], tabStops: [] };
  }
  return grid;
}

function buildTable(rows: LayoutLine[][]): LayoutTable {
  const starts: number[] = [];
  for (const x of rows.flatMap((r) => r.map((l) => l.rect.x)).sort((a, b) => a - b)) {
    if (starts.length && x - starts[starts.length - 1] < 10) continue;
    starts.push(x);
  }
  const right = Math.max(...rows.flatMap((r) => r.map((l) => maxX(l.rect))));
  const rowRects = rows.map((r) => r.reduce<Rect | null>((a, l) => union(a, l.rect), null)!);
  const tableRect = rowRects.reduce<Rect | null>((a, b) => union(a, b), null)!;
  const colEdges = [...starts, right + 6];
  const cells: LayoutCell[] = [];
  rows.forEach((r, ri) => {
    const byCol = new Map<number, LayoutLine[]>();
    for (const l of r) {
      const c = Math.max(0, starts.map((s, k) => [s, k] as const).filter(([s]) => s <= l.rect.x + 5).pop()?.[1] ?? 0);
      byCol.set(c, [...(byCol.get(c) ?? []), l]);
    }
    for (const [c, ls] of byCol) {
      const line: LayoutLine = ls.length === 1 ? { ...ls[0], runs: [...ls[0].runs] }
        : { ...ls[0], runs: ls.flatMap((l, i) => (i ? [{ ...l.runs[0], text: ' ' }, ...l.runs] : l.runs)), rect: ls.reduce<Rect>((a, l) => union(a, l.rect)!, ls[0].rect) };
      const cellRect = rect(colEdges[c], rowRects[ri].y, colEdges[c + 1] - colEdges[c], rowRects[ri].h);
      cells.push({ row: ri, col: c, rowSpan: 1, colSpan: 1, rect: cellRect, fill: null, borders: { top: false, bottom: false, left: false, right: false },
        lines: [line], alignment: isRTL(lineText(line)) ? 'right' : 'left', valign: 'top', rtl: isRTL(lineText(line)), pitch: lineSize(line) * 1.2 });
    }
  });
  return { kind: 'table', rect: tableRect, columns: starts, right, colEdges, rowEdges: [], cells, rowRects, bordered: false, ruled: false, rows: [] };
}

/** A page-space rect in display space with a top-left origin (what Office and HTML use). */
export function topLeft(l: { crop: Rect; rotation: number; width: number; height: number }, r: Rect): Rect {
  const c = l.crop;
  // Display → page transform inverse, per rotation (see PageTools.swift displayToPage).
  const pts = [[r.x, r.y], [r.x + r.w, r.y + r.h]].map(([x, y]) => {
    const px = x - c.x, py = y - c.y;
    switch (l.rotation) {
      case 90: return [py, c.w - px];
      case 180: return [c.w - px, c.h - py];
      case 270: return [c.h - py, px];
      default: return [px, py];
    }
  });
  const x0 = Math.min(pts[0][0], pts[1][0]), x1 = Math.max(pts[0][0], pts[1][0]);
  const y0 = Math.min(pts[0][1], pts[1][1]), y1 = Math.max(pts[0][1], pts[1][1]);
  return { x: x0, y: l.height - y1, w: x1 - x0, h: y1 - y0 };
}

export function textBounds(l: PageLayout): Rect | null {
  return l.items.filter((i) => i.kind !== 'image').reduce<Rect | null>((a, i) => union(a, topLeft(l, i.rect)), null);
}

export { contains };
