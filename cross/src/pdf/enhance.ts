// Cleaning up scanned pages before text recognition: straightening a tilted page and whitening a grey or yellowed
// background. A page is rewritten only when it needs it, at the scan's own resolution, keeping its comments.
import { PDFDocument, PDFName } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PageContent, containsRect } from '../engine/pageContent';
import { renderPage, canvasBytes } from './render';

export interface Enhancement {
  /** Degrees the text leans (positive: rising to the right); the page is turned back by this much. */
  angle: number;
  /** Paper and ink brightness (0–255) the levels are stretched between. */
  paper: number;
  ink: number;
}

/** Tilts below this, and paper brighter than this, are left alone. */
const MIN_ANGLE = 0.3, WHITE_ENOUGH = 238;

export const needsCleanup = (e: Enhancement) => Math.abs(e.angle) >= MIN_ANGLE || e.paper < WHITE_ENOUGH;

/** Measures tilt (projection profiles of the dark pixels, ±6° in 0.1° steps) and the paper and ink levels. */
export function analyse(canvas: HTMLCanvasElement): Enhancement {
  const k = Math.min(1, 900 / canvas.width);
  const w = Math.max(1, Math.round(canvas.width * k)), h = Math.max(1, Math.round(canvas.height * k));
  const small = document.createElement('canvas');
  small.width = w; small.height = h;
  const g = small.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(canvas, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const hist = new Uint32Array(256);
  const lum = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) { const l = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0; lum[j] = l; hist[l]++; }
  const level = (q: number) => { let n = 0; const target = q * w * h; for (let v = 0; v < 256; v++) { n += hist[v]; if (n >= target) return v; } return 255; };
  const paper = level(0.75), ink = level(0.01);
  // Dark pixels, well below the paper.
  const cut = ink + (paper - ink) * 0.5;
  const xs: number[] = [], ys: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (lum[y * w + x] < cut) { xs.push(x - w / 2); ys.push(y); }
  let angle = 0;
  if (xs.length > 200 && xs.length < w * h * 0.4) {
    let best = -1;
    const rows = new Float64Array(h * 2 + 2);
    for (let a = -6; a <= 6.0001; a += 0.1) {
      const t = Math.tan((a * Math.PI) / 180);
      rows.fill(0);
      for (let i = 0; i < xs.length; i++) { const r = Math.round(ys[i] + xs[i] * t) + h / 2; if (r >= 0 && r < rows.length) rows[r | 0]++; }
      // Text lines line up with the rows when the sum of squares peaks.
      let score = 0;
      for (let r = 0; r < rows.length; r++) score += rows[r] * rows[r];
      if (score > best) { best = score; angle = a; }
    }
  }
  return { angle: Math.round(angle * 10) / 10, paper, ink };
}

/** The page turned straight and its levels stretched so the paper is white and the ink stays dark. */
export function cleaned(canvas: HTMLCanvasElement, e: Enhancement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = canvas.width; out.height = canvas.height;
  const g = out.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, out.width, out.height);
  g.translate(out.width / 2, out.height / 2);
  // Canvas angles turn clockwise; a line rising to the right needs exactly that.
  if (Math.abs(e.angle) >= MIN_ANGLE) g.rotate((e.angle * Math.PI) / 180);
  g.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (e.paper < WHITE_ENOUGH && e.paper - e.ink > 40) {
    const img = g.getImageData(0, 0, out.width, out.height);
    const d = img.data, span = (e.paper - e.ink) * 0.94;
    const map = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) map[v] = ((v - e.ink) / span) * 255;
    for (let i = 0; i < d.length; i += 4) { d[i] = map[d[i]]; d[i + 1] = map[d[i + 1]]; d[i + 2] = map[d[i + 2]]; }
    g.putImageData(img, 0, 0);
  }
  return out;
}

/**
 * Pages that are a scan: no text, unrotated, and an image covering most of the page. Returns each with the scale
 * that renders it at the scan's own resolution (150–300 dpi).
 */
export async function scannedPages(doc: PDFDocument, js: PDFDocumentProxy, pages: number[]): Promise<{ page: number; scale: number }[]> {
  const out: { page: number; scale: number }[] = [];
  for (const i of pages) {
    const p = doc.getPage(i);
    if (p.getRotation().angle % 360 !== 0) continue;
    const tc = await (await js.getPage(i + 1)).getTextContent();
    if (tc.items.some((it) => 'str' in it && it.str.trim())) continue;
    const c = p.getCropBox();
    const inner = { x: c.x + c.width * 0.1, y: c.y + c.height * 0.1, w: c.width * 0.8, h: c.height * 0.8 };
    const pc = new PageContent(doc, p);
    const scan = pc.objects.find((o) => o.kind !== 'form' && containsRect(o.bounds, inner));
    if (!scan) continue;
    const info = pc.imageStream(scan);
    const dpi = info?.width ? (info.width / scan.bounds.w) * 72 : 200;
    out.push({ page: i, scale: Math.min(300, Math.max(150, dpi)) / 72 });
  }
  return out;
}

/** Renders, measures and cleans each scanned page; returns the pages that changed as JPEG pictures. */
export async function cleanScans(js: PDFDocumentProxy, pages: { page: number; scale: number }[], progress: (p: number) => void) {
  const out = new Map<number, { jpeg: Uint8Array; e: Enhancement }>();
  for (const [n, { page, scale }] of pages.entries()) {
    const canvas = await renderPage(js, page, scale, { annotations: false });
    const e = analyse(canvas);
    if (needsCleanup(e)) out.set(page, { jpeg: await canvasBytes(cleaned(canvas, e), 'image/jpeg', 0.9), e });
    progress((n + 1) / pages.length);
  }
  return out;
}

/** Replaces a page's drawing with one picture, keeping its comments and links. */
export async function replacePageImage(doc: PDFDocument, pageIndex: number, jpeg: Uint8Array) {
  const page = doc.getPage(pageIndex);
  const crop = page.getCropBox();
  const img = await doc.embedJpg(jpeg);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new Uint8Array())));
  page.drawImage(img, { x: crop.x, y: crop.y, width: crop.width, height: crop.height });
}
