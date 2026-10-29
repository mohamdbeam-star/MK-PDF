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
  /** Shaded or outlined boxes with text inside (banners, notices, cards), page space. */
  boxes: LayoutBox[];
  /** Two-column bands, read column by column. */
  columns: ColumnBand[];
}

export type BoxSide = { color: [number, number, number]; width: number } | null;
export interface LayoutBox {
  rect: Rect;
  /** Mostly drawing (a chart or diagram): exported as a picture of the box rather than as text. */
  figure: boolean;
  fill: [number, number, number] | null;
  borders: { top: BoxSide; right: BoxSide; bottom: BoxSide; left: BoxSide };
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
  // Right-to-left text placed letter by letter comes as one-letter items in drawing order; its space items are
  // unreliable (drawn far from where they read), so word gaps come from the letters' positions instead.
  const solid = hits.filter((h) => h.str.trim());
  const visual = solid.length > 1 && solid.some((h) => RTL.test(h.str)) && solid.every((h) => !h.rtl || Array.from(h.str.trim()).length <= 2);
  let out = '';
  let lastEnd: number | null = null;
  for (const it of visual ? solid : hits) {
    const cw = it.w / it.str.length || 1;
    const from = Math.max(0, Math.round((r.x - it.x) / cw));
    const to = Math.min(it.str.length, Math.round((maxX(r) - it.x) / cw));
    let s = it.rtl || to - from > it.str.length * 0.8 ? it.str : it.str.slice(from, to);
    if (it.rtl && (from > 0 || to < it.str.length) && to - from < it.str.length * 0.8) {
      const n = it.str.length;
      s = it.str.slice(n - to, n - from);
    }
    // (Joined letters touch, so in letter-by-letter text a smaller gap already separates words.)
    if (lastEnd !== null && it.x - lastEnd > it.h * (visual ? 0.12 : 0.2) && !out.endsWith(' ') && !s.startsWith(' ')) out += ' ';
    out += s;
    lastEnd = it.x + it.w;
  }
  const text = out.replace(/\s+/g, ' ').trim();
  // Right-to-left text that pdf.js left in drawing (visual) order is read right to left.
  const ordered = visual || (!hits.some((h) => h.rtl) && RTL.test(text)) ? visualToLogical(text) : text;
  // Arabic positional letter shapes (after ordering, so a lam-alef ligature stays in order) become ordinary letters.
  return /[\uFB50-\uFDFF\uFE70-\uFEFF]/.test(ordered) ? ordered.normalize('NFKC') : ordered;
}

const RTL = /[\u0590-\u065F\u066A-\u06EF\u06FA-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };

/** Visual (left-to-right drawing order) right-to-left text → reading order; numbers and Latin words keep their order. */
export function visualToLogical(s: string): string {
  // Units: a letter with the marks after it.
  const units: string[] = [];
  for (const ch of Array.from(s)) {
    if (/\p{M}/u.test(ch) && units.length) units[units.length - 1] += ch;
    else units.push(ch);
  }
  const ltr = (u: string) => /[\p{L}\p{N}]/u.test(u) && !RTL.test(u);
  const neutral = (u: string) => !ltr(u) && !RTL.test(u);
  let out = '';
  for (let i = units.length - 1; i >= 0;) {
    if (!ltr(units[i])) { out += RTL.test(units[i]) ? units[i] : (MIRROR[units[i]] ?? units[i]); i--; continue; }
    let j = i;
    while (j > 0) {
      if (ltr(units[j - 1])) { j--; continue; }
      let k = j - 1;
      while (k >= 0 && neutral(units[k])) k--;
      if (k >= 0 && ltr(units[k])) j = k; else break;
    }
    out += units.slice(j, i + 1).join('');
    i = j - 1;
  }
  return out;
}

/**
 * pdf.js adds word spacing to every space, including the two-byte spaces of composite fonts that the page draws
 * without it, so on justified lines its text drifts right of the glyphs. Each run of items is stretched back onto
 * the glyphs it covers (per baseline and per segment, since every column starts at its own position). It also
 * drops the space between items in different fonts ("this" + bold "Agreement"); the page's space glyph puts it back.
 */
function alignItems(raw: TextItem[], glyphs: Glyph[]): TextItem[] {
  // Text drawn twice on top of itself (a fake bold) comes back twice.
  const items: TextItem[] = [];
  for (const it of raw) {
    if (items.some((k) => k.str === it.str && Math.abs(k.y - it.y) < 0.5 && Math.abs(k.x - it.x) < Math.max(0.8, it.w * 0.1))) continue;
    items.push(it);
  }
  const runs: { y: number; x0: number; x1: number }[] = [];
  const all = glyphs.slice().sort((a, b) => a.rect.x - b.rect.x);
  const sorted = glyphs.filter((g) => !isSpace(g)).sort((a, b) => b.origin.y - a.origin.y || a.rect.x - b.rect.x);
  let line: Glyph[] = [];
  const endLine = () => {
    line.sort((a, b) => a.rect.x - b.rect.x);
    let run: { y: number; x0: number; x1: number } | null = null;
    for (const g of line) {
      if (run && g.rect.x - run.x1 <= g.size * 1.6) run.x1 = Math.max(run.x1, maxX(g.rect));
      else { run = { y: line[0].origin.y, x0: g.rect.x, x1: maxX(g.rect) }; runs.push(run); }
    }
    line = [];
  };
  for (const g of sorted) {
    if (line.length && Math.abs(g.origin.y - line[0].origin.y) > 0.6) endLine();
    line.push(g);
  }
  endLine();
  const out = items.slice();
  const byLine = new Map<number, number[]>();
  items.forEach((it, i) => { if (!it.rtl) { const k = Math.round(it.y * 2); byLine.set(k, [...(byLine.get(k) ?? []), i]); } });
  for (const idx of byLine.values()) {
    const y = items[idx[0]].y;
    const mine = runs.filter((r) => Math.abs(r.y - y) <= 0.6).sort((a, b) => a.x0 - b.x0);
    if (!mine.length) continue;
    idx.sort((a, b) => items[a].x - items[b].x);
    mine.forEach((run, k) => {
      const next = mine[k + 1]?.x0 ?? Infinity;
      const group = idx.filter((i) => items[i].x >= run.x0 - 2 && items[i].x < next - 2);
      const solid = group.filter((i) => items[i].str.trim());
      if (!solid.length) return;
      const ix0 = items[solid[0]].x, ix1 = Math.max(...solid.map((i) => items[i].x + items[i].w));
      const scale = (run.x1 - run.x0) / (ix1 - ix0);
      if (!(ix1 > ix0) || Math.abs(scale - 1) < 0.003 || scale < 0.8 || scale > 1.25) return;
      for (const i of group) out[i] = { ...items[i], x: run.x0 + (items[i].x - ix0) * scale, w: items[i].w * scale };
    });
    const onLine = all.filter((g) => Math.abs(g.origin.y - y) <= 0.6);
    for (let k = 1; k < idx.length; k++) {
      const a = out[idx[k - 1]], b = out[idx[k]];
      if (/\s$/.test(a.str) || /^\s/.test(b.str)) continue;
      const before = onLine.filter((g) => g.rect.x < b.x - 0.3).pop();
      if (before && isSpace(before) && before.rect.x > a.x) out[idx[k - 1]] = { ...a, str: a.str + ' ' };
    }
  }
  return out;
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
  const text = Array.isArray(items) ? indexText(alignItems(items, glyphs)) : null;
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
    // Spaces drawn as glyphs (some PDF writers, e.g. Chromium, draw every character): map character by character.
    const spacesDrawn = groups.length > 1 && chars.length === visible.length && chars.filter((c) => c.trim()).length !== visible.length;
    if (spacesDrawn) {
      runs = [];
      let cur = '', st = style(visible[0]), first = visible[0];
      chars.forEach((ch, k) => {
        const g = visible[k], s2 = style(g);
        const same = s2.res === st.res && s2.size === st.size && s2.color === st.color && s2.invisible === st.invisible && s2.rise === st.rise;
        if (!same && ch.trim()) { runs.push(run(st, first, cur)); cur = ''; st = s2; first = g; }
        cur += ch;
      });
      runs.push(run(st, first, cur));
    } else if (groups.length > 1 && chars.filter((c) => c.trim()).length === visible.length) {
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

  // Text outside ruled tables flows in its region: the page, or each column of a multi-column band.
  const rest = glyphs.filter((g) => !inGrid.has(g));
  const boxes = findBoxes(pc, glyphs, grids.map((g) => g.rect), cropR);
  const inAnyBox = (g: Glyph) => { const m = { x: g.rect.x + g.rect.w / 2, y: g.rect.y + g.rect.h / 2 }; return boxes.some((b) => contains(b.rect, m)); };
  // Lines or banners running across the gutter make it a form or a table without vertical lines (label | value
  // rows), not text columns.
  const bands = findColumns(segmentRows(rest.filter((g) => !inAnyBox(g)))).filter((b) => {
    const at = b.cols[1].x;
    if (boxes.some((x) => x.rect.x < at - 5 && maxX(x.rect) > at + 5 && intersects(x.rect, b.rect))) return false;
    return pc.rules.filter((r) => r.w >= 30 && r.h <= 3 && r.x < at - 5 && maxX(r) > at + 5 && r.y > b.rect.y - 3 && r.y < maxY(b.rect) + 3).length < 2;
  });
  const flow = (subset: Glyph[], frame: Rect) => {
    // 2. Remaining rows by baseline, split into segments at column-sized gaps or runs of 3+ spaces.
    const rows = segmentRows(subset);
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
      if (g.length === 1 && Math.abs(r.x + r.w / 2 - (frame.x + frame.w / 2)) < 6 && r.x - frame.x > Math.min(90, frame.w * 0.15) && !g[0].parts.length) alignment = 'center';
      // Centred lines (titles, addresses) are always broken where the author broke them.
      if (alignment === 'center') g.slice(0, -1).forEach((l) => (l.hardBreak = true)); else markBreaks(g, r, alignment);
      const pitch = g.length > 1 ? g[0].baseline - g[1].baseline : lineSize(g[0]) * 1.2;
      const behind = [...pc.fills].reverse().find((f) => f.rect.w > r.w * 0.9 && f.rect.x <= r.x + 1 && maxX(f.rect) >= maxX(r) - 1 && f.rect.y <= r.y + 1 && maxY(f.rect) >= maxY(r) - 1
        && f.rect.h < Math.max(r.h * 8, 80) && !f.color.every((c) => c > 0.97));
      const onImage = pc.objects.some((o) => o.kind !== 'form' && o.bounds.x <= r.x + 1 && maxX(o.bounds) >= maxX(r) - 1 && o.bounds.y <= r.y + 1 && maxY(o.bounds) >= maxY(r) - 1);
      out.push({ kind: 'paragraph', rect: r, lines: g, alignment, rtl, pitch, ...(behind ? { backdrop: { rect: behind.rect, color: behind.color } } : {}), ...(onImage ? { onImage } : {}) });
    }
  };
  const midOf = (g: Glyph) => ({ x: g.rect.x + g.rect.w / 2, y: g.rect.y + g.rect.h / 2 });
  const inBand = (g: Glyph) => (inAnyBox(g) ? undefined : bands.find((b) => contains(b.rect, midOf(g))));
  flow(rest.filter((g) => !inBand(g)), cropR);
  for (const b of bands) {
    const mine = rest.filter((g) => inBand(g) === b);
    // Each row splits where its own gap is (justified columns don't leave a perfectly straight gutter).
    const splitFor = (g: Glyph) => { const m = midOf(g); return b.splits.find((r) => m.y >= r.y0 && m.y <= r.y1)?.x ?? b.cols[1].x; };
    flow(mine.filter((g) => midOf(g).x < splitFor(g)), b.cols[0]);
    flow(mine.filter((g) => midOf(g).x >= splitFor(g)), b.cols[1]);
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

  // Lines inside a box or along its edges belong to the box (its borders, a chart's gridlines).
  const inBox = (r: Rect) => boxes.some((b) => r.x >= b.rect.x - 3 && maxX(r) <= maxX(b.rect) + 3 && r.y >= b.rect.y - 3 && maxY(r) <= maxY(b.rect) + 3);
  const layout: PageLayout = { index, width: swap ? cropR.h : cropR.w, height: swap ? cropR.w : cropR.h, crop: cropR, rotation, items: [],
    rules: dividers.filter((d) => !inBox(d.rect)), boxes, columns: bands };
  layout.items = out.sort((a, b) => {
    const ra = topLeft(layout, a.rect), rb = topLeft(layout, b.rect);
    return Math.abs(ra.y - rb.y) > 4 ? ra.y - rb.y : ra.x - rb.x;
  });
  return layout;
}

/**
 * Boxes: a filled shape (often rounded) with text inside and no table in it. Borders come from an outline drawn
 * on the same shape, or from shapes just under it that show around its edges (an accent stripe on one side).
 */
function findBoxes(pc: PageContent, glyphs: Glyph[], tables: Rect[], page: Rect): LayoutBox[] {
  const shapes = pc.shapes;
  const near = (a: Rect, b: Rect, t: number) => Math.abs(a.x - b.x) <= t && Math.abs(a.y - b.y) <= t && Math.abs(maxX(a) - maxX(b)) <= t && Math.abs(maxY(a) - maxY(b)) <= t;
  const inside = (p: { x: number; y: number }, r: Rect) => p.x >= r.x && p.x <= maxX(r) && p.y >= r.y && p.y <= maxY(r);
  const boxes: LayoutBox[] = [];
  shapes.forEach((s, i) => {
    const r = s.rect;
    if (!s.fill || r.w < 40 || r.h < 16 || r.w * r.h > page.w * page.h * 0.6) return;
    if (tables.some((t) => intersects(t, r))) return;
    if (!glyphs.some((g) => inside({ x: g.rect.x + g.rect.w / 2, y: g.rect.y + g.rect.h / 2 }, r))) return;
    // The same shape drawn again (or another fill exactly on top) wins; an earlier, larger one is its border.
    if (shapes.slice(i + 1).some((o) => o.fill && near(o.rect, r, 1.5) && (o.rect.w * o.rect.h) <= r.w * r.h * 1.02)) return;
    const outline = shapes.find((o) => o.stroke && near(o.rect, r, 2));
    const w = Math.max(0.5, outline?.lineWidth ?? 0.5);
    const line: BoxSide = outline?.stroke ? { color: outline.stroke, width: w } : null;
    // Strips along an edge (borders drawn as thin bars, often an accent on one side) override the outline there.
    const strip = (pick: (q: Rect) => boolean, width: (q: Rect) => number): BoxSide => {
      const k = pc.rules.findIndex(pick);
      return k >= 0 ? { color: pc.ruleColors[k] ?? [0, 0, 0], width: Math.max(0.5, width(pc.rules[k])) } : null;
    };
    // A strip counts for a side when it runs along most of that side and touches or tucks under the edge.
    const spansV = (q: Rect) => q.h >= r.h * 0.6 && q.w < 8 && q.y <= r.y + r.h * 0.4 && maxY(q) >= maxY(r) - r.h * 0.4;
    const spansH = (q: Rect) => q.w >= r.w * 0.6 && q.h < 8 && q.x <= r.x + r.w * 0.4 && maxX(q) >= maxX(r) - r.w * 0.4;
    const borders: LayoutBox['borders'] = {
      left: strip((q) => spansV(q) && q.x <= r.x + 1 && maxX(q) >= r.x - 1.5 && maxX(q) <= r.x + 6, (q) => Math.max(r.x - q.x, 0.5)) ?? line,
      right: strip((q) => spansV(q) && maxX(q) >= maxX(r) - 1 && q.x <= maxX(r) + 1.5 && q.x >= maxX(r) - 6, (q) => Math.max(maxX(q) - maxX(r), 0.5)) ?? line,
      top: strip((q) => spansH(q) && maxY(q) >= maxY(r) - 1 && q.y <= maxY(r) + 1.5 && q.y >= maxY(r) - 6, (q) => Math.max(maxY(q) - maxY(r), 0.5)) ?? line,
      bottom: strip((q) => spansH(q) && q.y <= r.y + 1 && maxY(q) >= r.y - 1.5 && maxY(q) <= r.y + 6, (q) => Math.max(r.y - q.y, 0.5)) ?? line,
    };
    // Lines and curves inside that aren't the box's own outline: a chart or diagram.
    const within = (q: Rect) => q.x >= r.x - 1 && maxX(q) <= maxX(r) + 1 && q.y >= r.y - 1 && maxY(q) <= maxY(r) + 1;
    const curves = shapes.filter((o) => o !== s && o !== outline && !near(o.rect, r, 2) && within(o.rect) && o.stroke && o.rounded).length;
    // Interior lines (gridlines, axes), not the box's own edges.
    const lines = pc.rules.filter((q) => within(q) && q.x > r.x + 3 && maxX(q) < maxX(r) - 3 && q.y > r.y + 3 && maxY(q) < maxY(r) - 3).length;
    // A white shape without any border is just page background: invisible, so not a box.
    const plain = s.fill.every((c) => c > 0.985) && !borders.top && !borders.right && !borders.bottom && !borders.left;
    if (!plain) boxes.push({ rect: r, fill: s.fill, borders, figure: curves >= 2 || (curves >= 1 && curves + lines >= 3) });
  });
  // Keep the innermost box for nested ones with the same text.
  return boxes.filter((b) => !boxes.some((o) => o !== b && o.rect.w * o.rect.h < b.rect.w * b.rect.h && near(o.rect, b.rect, 0) === false
    && o.rect.x >= b.rect.x - 0.5 && o.rect.y >= b.rect.y - 0.5 && maxX(o.rect) <= maxX(b.rect) + 0.5 && maxY(o.rect) <= maxY(b.rect) + 0.5
    && glyphs.filter((g) => inside({ x: g.rect.x + g.rect.w / 2, y: g.rect.y + g.rect.h / 2 }, b.rect)).every((g) => inside({ x: g.rect.x + g.rect.w / 2, y: g.rect.y + g.rect.h / 2 }, o.rect))));
}

/** A run of rows laid out in two columns (newspaper style): the band, each column's area, and where each row splits. */
export interface ColumnBand { rect: Rect; cols: Rect[]; splits: { y0: number; y1: number; x: number }[] }

/**
 * Finds two-column bands with a projection profile: across the rows, count how many have ink at each x. A gutter
 * is a valley no (or almost no) row inks, between two well-filled column areas. A row breaks the band only if a
 * letter sits on the gutter; each row splits at its own gap there (justified columns don't leave a perfectly
 * straight gutter, and the two columns' baselines needn't line up). A band is read column by column.
 */
function findColumns(rows: Glyph[][][]): ColumnBand[] {
  const lines = rows.map((row) => {
    const glyphs = row.flat().filter((g) => !isSpace(g)).map((g) => g.rect).sort((a, b) => a.x - b.x);
    const all = row.flat();
    return { glyphs, top: Math.max(...all.map((g) => maxY(g.rect))), bottom: Math.min(...all.map((g) => g.rect.y)) };
  }).filter((l) => l.glyphs.length);
  if (lines.length < 8) return [];
  const bands: ColumnBand[] = [];
  let remaining = lines;
  for (let round = 0; round < 2 && remaining.length >= 8; round++) {
    const tx0 = Math.min(...remaining.map((l) => l.glyphs[0].x)), tx1 = Math.max(...remaining.flatMap((l) => l.glyphs.map((g) => maxX(g))));
    const width = tx1 - tx0;
    if (width < 200) break;
    const bins = Math.ceil(width) + 1, ink = new Array<number>(bins).fill(0);
    for (const l of remaining) {
      const hit = new Uint8Array(bins);
      for (const g of l.glyphs) for (let x = Math.max(0, Math.floor(g.x - tx0)); x <= Math.min(bins - 1, Math.ceil(maxX(g) - tx0)); x++) hit[x] = 1;
      hit.forEach((h, x) => { ink[x] += h; });
    }
    // The emptiest point in the middle 30–70%, with busy columns on both sides.
    let gx = -1, low = Infinity;
    for (let x = Math.floor(width * 0.3); x <= Math.ceil(width * 0.7); x++) if (ink[x] < low) { low = ink[x]; gx = x; }
    // Within that valley, just left of where the right column starts, so text starting right at the valley's edge (a
    // column's headings) stays on its side.
    if (gx >= 0) { let a = gx, b = gx; while (a > 0 && ink[a - 1] <= low) a--; while (b < bins - 1 && ink[b + 1] <= low) b++; gx = Math.round(Math.max((a + b) / 2, b - 6)); }
    const avg = (from: number, to: number) => { let t = 0, n = 0; for (let x = Math.max(0, from); x < Math.min(bins, to); x++) { t += ink[x]; n++; } return n ? t / n : 0; };
    const leftBusy = avg(Math.floor(width * 0.1), gx - 10), rightBusy = avg(gx + 10, Math.ceil(width * 0.9));
    const n = remaining.length;
    if (low > Math.max(1, n * 0.12) || leftBusy < Math.max(3, n * 0.15) || rightBusy < Math.max(3, n * 0.15)) break;
    const at = tx0 + gx;
    // Where the right column's lines start; a line starting well left of that (a centred title) crosses the gutter.
    const starts = remaining.map((l) => l.glyphs.find((g) => g.x >= at)?.x).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
    const rightStart = starts[Math.floor(starts.length * 0.1)] ?? at;
    const kind = remaining.map((l) => {
      if (l.glyphs.some((g) => g.x < at - 0.5 && maxX(g) > at + 0.5)) return 'across' as const;
      const first = l.glyphs.find((g) => g.x >= at);
      if (first && first.x < rightStart - 15 && !l.glyphs.some((g) => maxX(g) <= at)) return 'across' as const;
      const left = l.glyphs.some((g) => maxX(g) <= at), right = l.glyphs.some((g) => g.x >= at);
      return left && right ? ('both' as const) : left ? ('left' as const) : ('right' as const);
    });
    // The longest run without a letter on the gutter, with plenty of text on each side.
    let best: [number, number, number] | null = null, start = 0;
    const close = (end: number) => {
      const k = kind.slice(start, end), l = k.filter((x) => x !== 'right').length, r = k.filter((x) => x !== 'left').length;
      if (l >= 4 && r >= 4 && l + r >= 10 && (!best || l + r > best[2])) best = [start, end, l + r];
    };
    // A wide empty stretch (the space above a footer) also ends a run.
    const heights = remaining.map((l) => l.top - l.bottom).sort((a, b) => a - b), gapLimit = Math.max(30, heights[heights.length >> 1] * 4);
    kind.forEach((k, i) => {
      if (k === 'across') { close(i); start = i + 1; } else if (i > start && remaining[i - 1].bottom - remaining[i].top > gapLimit) { close(i); start = i; }
    });
    close(kind.length);
    if (!best) break;
    const [from, to] = best as [number, number, number];
    const run = remaining.slice(from, to);
    // Columns must be long lines, not a table's short cells.
    const sideWidths = (left: boolean) => run.map((l) => { const gs = l.glyphs.filter((g) => (left ? maxX(g) <= at : g.x >= at)); return gs.length ? maxX(gs[gs.length - 1]) - gs[0].x : 0; })
      .filter((w) => w > 0).sort((a, b) => a - b);
    const lw = sideWidths(true), rw = sideWidths(false);
    if (lw[lw.length >> 1] < width * 0.25 || rw[rw.length >> 1] < width * 0.25) break;
    const top = Math.max(...run.map((l) => l.top)), bottom = Math.min(...run.map((l) => l.bottom));
    const rect = { x: tx0, y: bottom - 1, w: width, h: top - bottom + 2 };
    const splits = run.map((l) => {
      const before = l.glyphs.filter((g) => maxX(g) <= at), after = l.glyphs.filter((g) => g.x >= at);
      const x = before.length && after.length ? (maxX(before[before.length - 1]) + after[0].x) / 2 : at;
      return { y0: l.bottom - 0.5, y1: l.top + 0.5, x };
    });
    if (rect.h > 40) bands.push({ rect, splits, cols: [{ x: tx0, y: rect.y, w: at - tx0, h: rect.h }, { x: at, y: rect.y, w: tx1 - at, h: rect.h }] });
    remaining = [...remaining.slice(0, from), ...remaining.slice(to)];
  }
  return bands;
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
