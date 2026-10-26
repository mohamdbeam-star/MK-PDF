// Editing recognised (OCR) text over scans and drawings: the letters on the page are pixels, so an edit
// covers the old line with the paper colour and writes the new text in the ink colour.
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { LayoutParagraph } from '../engine/layout';
import type { Rect } from '../engine/pageContent';
import { renderPage } from './render';

export type RGB = [number, number, number];

export const isScanned = (b: LayoutParagraph) => b.lines.every((l) => l.runs.every((r) => r.invisible));

/** Cover rects for a block's lines (recognised boxes hug letters loosely, so generously). */
export const coverRects = (b: LayoutParagraph): Rect[] =>
  b.lines.map((l) => ({ x: l.rect.x - 2, y: l.rect.y - l.rect.h * 0.3, w: l.rect.w + 4, h: l.rect.h * 1.75 }));

/** Paper (the median of a ring around the rect) and ink (the darkest fifth of clearly different pixels). */
export async function sampleColors(js: PDFDocumentProxy, pageIndex: number, r: Rect): Promise<{ paper: RGB; ink: RGB }> {
  const scale = 2;
  const canvas = await renderPage(js, pageIndex, scale, { annotations: true });
  const page = await js.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale });
  const a = vp.convertToViewportPoint(r.x - 3, r.y - 3) as number[], b = vp.convertToViewportPoint(r.x + r.w + 3, r.y + r.h + 3) as number[];
  const x = Math.max(0, Math.floor(Math.min(a[0], b[0]))), y = Math.max(0, Math.floor(Math.min(a[1], b[1])));
  const w = Math.min(canvas.width - x, Math.ceil(Math.abs(b[0] - a[0]))), h = Math.min(canvas.height - y, Math.ceil(Math.abs(b[1] - a[1])));
  if (w < 4 || h < 4) return { paper: [1, 1, 1], ink: [0, 0, 0] };
  const data = canvas.getContext('2d')!.getImageData(x, y, w, h).data;
  const px = (i: number, j: number): RGB => { const k = (j * w + i) * 4; return [data[k] / 255, data[k + 1] / 255, data[k + 2] / 255]; };
  const ring: RGB[] = [];
  for (let i = 0; i < w; i++) ring.push(px(i, 0), px(i, h - 1));
  for (let j = 0; j < h; j++) ring.push(px(0, j), px(w - 1, j));
  const median = (v: number[]) => [...v].sort((p, q) => p - q)[Math.floor(v.length / 2)];
  const paper: RGB = [0, 1, 2].map((c) => median(ring.map((p) => p[c]))) as RGB;
  const ink: RGB[] = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const p = px(i, j);
    if (Math.abs(p[0] - paper[0]) + Math.abs(p[1] - paper[1]) + Math.abs(p[2] - paper[2]) > 0.6) ink.push(p);
  }
  ink.sort((p, q) => p[0] + p[1] + p[2] - (q[0] + q[1] + q[2]));
  const dark = ink.slice(0, Math.max(1, Math.floor(ink.length / 5)));
  const avg = dark.length && ink.length ? ([0, 1, 2].map((c) => dark.reduce((s, p) => s + p[c], 0) / dark.length) as RGB) : ([0, 0, 0] as RGB);
  return { paper, ink: avg };
}

/** Whether a page has any text at all (pdf.js text content). */
export async function pageHasText(js: PDFDocumentProxy, pageIndex: number): Promise<boolean> {
  const tc = await (await js.getPage(pageIndex + 1)).getTextContent();
  return tc.items.some((it) => 'str' in it && (it as { str: string }).str.trim().length > 0);
}
