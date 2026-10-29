// Ruled tables: rebuilds a table's grid from the lines, cell borders and shading that draw it, including
// merged cells. Text placement then follows the real cells instead of guessing columns from text positions.
import { Rect, maxX, maxY, rect } from './pageContent';

export interface GridCell {
  row: number; col: number; rowSpan: number; colSpan: number;
  rect: Rect;
  fill: [number, number, number] | null;
  borders: { top: boolean; bottom: boolean; left: boolean; right: boolean };
}
export interface Grid {
  rect: Rect;
  borderColor: [number, number, number];
  colEdges: number[];   // left → right
  rowEdges: number[];   // top → bottom (page space, so descending y)
  cells: GridCell[];
}

interface HSeg { y: number; x0: number; x1: number }
interface VSeg { x: number; y0: number; y1: number }

const TOL = 2;

/** Groups values closer than `gap` and returns each group's mean, ascending. */
function cluster(values: number[], gap: number): number[] {
  const out: number[][] = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && v - last[last.length - 1] <= gap) last.push(v); else out.push([v]);
  }
  return out.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
}

/** Joins collinear segments that overlap or nearly touch. */
function mergeH(segs: HSeg[]): HSeg[] {
  const out: HSeg[] = [];
  for (const s of [...segs].sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    const m = out.find((o) => Math.abs(o.y - s.y) <= 1.5 && s.x0 <= o.x1 + 3 && s.x1 >= o.x0 - 3);
    if (m) { m.x0 = Math.min(m.x0, s.x0); m.x1 = Math.max(m.x1, s.x1); m.y = (m.y + s.y) / 2; } else out.push({ ...s });
  }
  return out;
}
function mergeV(segs: VSeg[]): VSeg[] {
  const out: VSeg[] = [];
  for (const s of [...segs].sort((a, b) => a.x - b.x || a.y0 - b.y0)) {
    const m = out.find((o) => Math.abs(o.x - s.x) <= 1.5 && s.y0 <= o.y1 + 3 && s.y1 >= o.y0 - 3);
    if (m) { m.y0 = Math.min(m.y0, s.y0); m.y1 = Math.max(m.y1, s.y1); m.x = (m.x + s.x) / 2; } else out.push({ ...s });
  }
  return out;
}

const light = (c: [number, number, number]) => c.every((v) => v > 0.97);

/** Finds ruled tables on a page from its rules (thin lines and bars) and filled rectangles. */
export function findGrids(rules: Rect[], ruleColors: [number, number, number][], fills: { rect: Rect; color: [number, number, number] }[], page: Rect, ink: Rect[] = []): Grid[] {
  let hs: HSeg[] = [], vs: VSeg[] = [];
  for (const r of rules) {
    if (r.w >= r.h && r.w > 3) hs.push({ y: r.y + r.h / 2, x0: r.x, x1: maxX(r) });
    else if (r.h > r.w && r.h > 3) vs.push({ x: r.x + r.w / 2, y0: r.y, y1: maxY(r) });
  }
  const rawH = hs.map((s) => ({ ...s }));
  // Coloured cell backgrounds outline cells too (e.g. header rows drawn without borders).
  // Their edges snap to a drawn line a few points away, so a shading inset doesn't add a sliver row.
  const candidates = fills.filter((f) => f.rect.w > 3 && f.rect.h > 3 && !light(f.color) && f.rect.w * f.rect.h < page.w * page.h * 0.5);
  // Word paints a cell's shading and again behind its text; only the outer shape outlines the cell.
  const inside = (a: Rect, b: Rect) => a.x >= b.x - 1 && a.y >= b.y - 1 && maxX(a) <= maxX(b) + 1 && maxY(a) <= maxY(b) + 1;
  const shaded = candidates.filter((f, i) => !candidates.some((o, j) => j !== i && o.color.join() === f.color.join() && inside(f.rect, o.rect)
    && (!inside(o.rect, f.rect) || j < i)));
  hs = mergeH(hs); vs = mergeV(vs);
  const snapY = (y: number, x0: number, x1: number) => hs.find((s) => Math.abs(s.y - y) <= 6 && s.x0 < x1 && s.x1 > x0)?.y ?? y;
  const snapX = (x: number, y0: number, y1: number) => vs.find((s) => Math.abs(s.x - x) <= 6 && s.y0 < y1 && s.y1 > y0)?.x ?? x;
  const extraH: HSeg[] = [], extraV: VSeg[] = [];
  for (const { rect: r } of shaded) {
    const top = snapY(maxY(r), r.x, maxX(r)), bottom = snapY(r.y, r.x, maxX(r));
    const left = snapX(r.x, r.y, maxY(r)), right = snapX(maxX(r), r.y, maxY(r));
    extraH.push({ y: bottom, x0: left, x1: right }, { y: top, x0: left, x1: right });
    extraV.push({ x: left, y0: bottom, y1: top }, { x: right, y0: bottom, y1: top });
  }
  // Only drawn lines show as borders; shading edges and implied dividers just shape the grid.
  const drawnH = hs, drawnV = vs;
  // Tables without vertical lines (HTML-style, rows separated by lines drawn cell by cell): where one row
  // line ends and the next begins on the same row, at the same x on several rows, is a column divider.
  const pieces = [...rawH, ...extraH];
  const joints: { x: number; y: number }[] = [];
  for (const a of pieces) for (const b of pieces) {
    if (a !== b && Math.abs(a.y - b.y) <= 1 && Math.abs(a.x1 - b.x0) <= 1.5 && a.x1 - a.x0 > 8 && b.x1 - b.x0 > 8) joints.push({ x: (a.x1 + b.x0) / 2, y: a.y });
  }
  joints.sort((a, b) => a.x - b.x);
  const implied: VSeg[] = [];
  for (let i = 0; i < joints.length;) {
    let j = i;
    while (j + 1 < joints.length && joints[j + 1].x - joints[i].x <= 1.5) j++;
    const ys = [...new Set(joints.slice(i, j + 1).map((e) => Math.round(e.y)))].sort((a, b) => a - b);
    if (ys.length >= 2) implied.push({ x: joints[i].x, y0: ys[0], y1: ys[ys.length - 1] });
    i = j + 1;
  }
  hs = mergeH([...hs, ...extraH]); vs = mergeV([...vs, ...extraV, ...implied]);
  if (hs.length < 2 || !vs.length) return [];

  // Connected groups of crossing segments are separate tables.
  const n = hs.length + vs.length, parent = [...Array(n).keys()];
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  hs.forEach((h, i) => vs.forEach((v, j) => {
    if (v.x >= h.x0 - 3 && v.x <= h.x1 + 3 && h.y >= v.y0 - 3 && h.y <= v.y1 + 3) parent[find(i)] = find(hs.length + j);
  }));
  const groups = new Map<number, { h: HSeg[]; v: VSeg[] }>();
  hs.forEach((h, i) => { const g = groups.get(find(i)) ?? { h: [], v: [] }; g.h.push(h); groups.set(find(i), g); });
  vs.forEach((v, j) => { const g = groups.get(find(hs.length + j)) ?? { h: [], v: [] }; g.v.push(v); groups.set(find(hs.length + j), g); });

  const grids: Grid[] = [];
  for (const { h, v } of groups.values()) {
    if (h.length < 2 || v.length < 2) continue;
    const x0 = Math.min(...h.map((s) => s.x0), ...v.map((s) => s.x)), x1 = Math.max(...h.map((s) => s.x1), ...v.map((s) => s.x));
    const y0 = Math.min(...v.map((s) => s.y0), ...h.map((s) => s.y)), y1 = Math.max(...v.map((s) => s.y1), ...h.map((s) => s.y));
    if (x1 - x0 < 30 || y1 - y0 < 10) continue;
    const xs = cluster([x0, x1, ...v.map((s) => s.x)], 4);
    const ys = cluster([y0, y1, ...h.map((s) => s.y)], 4).reverse();
    const cols = xs.length - 1, rows = ys.length - 1;
    if (cols < 1 || rows < 1) continue;

    const covers = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) >= (b1 - b0) * 0.7;
    // Is there a vertical line at column edge k across row i, or a horizontal line at row edge k across column j?
    // An edge that's only implied (no line drawn there) doesn't split a cell that text runs across.
    const inkAcross = (i: number, k: number) => ink.some((g) => { const cy = g.y + g.h / 2; return cy < ys[i] && cy > ys[i + 1] && g.x < xs[k] - 1 && maxX(g) > xs[k] + 1; });
    const vEdge = (i: number, k: number) => v.some((s) => Math.abs(s.x - xs[k]) <= TOL + 1 && covers(s.y0, s.y1, ys[i + 1], ys[i]))
      && (drawnV.some((s) => Math.abs(s.x - xs[k]) <= TOL + 1 && covers(s.y0, s.y1, ys[i + 1], ys[i])) || !inkAcross(i, k));
    const hEdge = (k: number, j: number) => h.some((s) => Math.abs(s.y - ys[k]) <= TOL + 1 && covers(s.x0, s.x1, xs[j], xs[j + 1]));
    const vLine = (i: number, k: number) => drawnV.some((s) => Math.abs(s.x - xs[k]) <= TOL + 1 && covers(s.y0, s.y1, ys[i + 1], ys[i]));
    const hLine = (k: number, j: number) => drawnH.some((s) => Math.abs(s.y - ys[k]) <= TOL + 1 && covers(s.x0, s.x1, xs[j], xs[j + 1]));

    const taken = rows * cols > 0 ? Array.from({ length: rows }, () => Array<boolean>(cols).fill(false)) : [];
    const cells: GridCell[] = [];
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        if (taken[i][j]) continue;
        let cs = 1;
        while (j + cs < cols && !taken[i][j + cs] && !vEdge(i, j + cs)) cs++;
        let rs = 1;
        const canGrow = () => {
          if (i + rs >= rows) return false;
          for (let c = j; c < j + cs; c++) if (taken[i + rs][c] || hEdge(i + rs, c)) return false;
          return true;
        };
        while (canGrow()) rs++;
        for (let a = i; a < i + rs; a++) for (let b = j; b < j + cs; b++) taken[a][b] = true;
        const r = rect(xs[j], ys[i + rs], xs[j + cs] - xs[j], ys[i] - ys[i + rs]);
        const fill = [...shaded].reverse().find((f) => {
          const ix = Math.min(maxX(f.rect), maxX(r)) - Math.max(f.rect.x, r.x), iy = Math.min(maxY(f.rect), maxY(r)) - Math.max(f.rect.y, r.y);
          return ix > 0 && iy > 0 && ix * iy >= r.w * r.h * 0.6;
        })?.color ?? null;
        const all = (f: (k: number) => boolean, from: number, to: number) => { for (let k = from; k < to; k++) if (!f(k)) return false; return true; };
        cells.push({
          row: i, col: j, rowSpan: rs, colSpan: cs, rect: r, fill,
          borders: {
            top: all((c) => hLine(i, c), j, j + cs), bottom: all((c) => hLine(i + rs, c), j, j + cs),
            left: all((a) => vLine(a, j), i, i + rs), right: all((a) => vLine(a, j + cs), i, i + rs),
          },
        });
      }
    }
    // A single framed box (or a lone banner) is decoration, not a table.
    if (cols < 2 || !cells.some((c) => c.colSpan < cols)) continue;
    const box = rect(xs[0], ys[rows], xs[cols] - xs[0], ys[0] - ys[rows]);
    // The commonest colour among the rules inside the table.
    const tally = new Map<string, number>();
    rules.forEach((r, k) => { if (r.x >= box.x - 3 && maxX(r) <= maxX(box) + 3 && r.y >= box.y - 3 && maxY(r) <= maxY(box) + 3) { const key = (ruleColors[k] ?? [0, 0, 0]).join(); tally.set(key, (tally.get(key) ?? 0) + 1); } });
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const borderColor = (top ? top.split(',').map(Number) : [0.5, 0.5, 0.5]) as [number, number, number];
    grids.push({ rect: box, borderColor, colEdges: xs, rowEdges: ys, cells });
  }
  return grids;
}
