// Offline OCR with tesseract.js: recognised lines become invisible, selectable text over the scan.
import { createWorker, OEM } from 'tesseract.js';
import { PDFDocument, TextRenderingMode, beginText, endText, setCharacterSqueeze, setFontAndSize, setTextMatrix, setTextRenderingMode, showText } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { renderPage } from './render';
import { fontFor, hasArabic } from './fonts';

export interface OcrWord { text: string; confidence: number }
export interface OcrLine { text: string; x: number; y: number; w: number; h: number; words?: OcrWord[] } // page space

/** A word the recogniser wasn't sure of, with a picture of it from the scan and the other readings it considered. */
export interface Suspect { page: number; line: number; word: number; text: string; image: string; choices: string[] }

/** Words recognised with less confidence than this (0–100) are offered for review. */
export const SUSPECT_BELOW = 70;

const base = (p: string) => new URL(p, document.baseURI).href;

export async function recognize(js: PDFDocumentProxy, pages: number[], languages: string, progress: (p: number) => void,
  suspects?: Suspect[]): Promise<Map<number, OcrLine[]>> {
  const worker = await createWorker(languages, OEM.LSTM_ONLY, {
    workerPath: base('tesseract/worker.min.js'), corePath: base('tesseract/'), langPath: base('tessdata'), gzip: false, workerBlobURL: false,
  });
  const out = new Map<number, OcrLine[]>();
  try {
    for (const [n, i] of pages.entries()) {
      const page = await js.getPage(i + 1);
      const scale = 2.5;
      const viewport = page.getViewport({ scale, rotation: 0 });
      const canvas = await renderPage(js, i, scale, { annotations: false });
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      const lines: OcrLine[] = [];
      for (const block of data.blocks ?? []) for (const para of block.paragraphs) for (const line of para.lines) {
        const t = line.text.trim();
        if (!t || line.confidence < 30) continue;
        const [x0, y0] = viewport.convertToPdfPoint(line.bbox.x0, line.bbox.y1);
        const [x1, y1] = viewport.convertToPdfPoint(line.bbox.x1, line.bbox.y0);
        const words = line.words.filter((w) => w.text.trim()).map((w) => ({ text: w.text.trim(), confidence: w.confidence }));
        if (suspects) line.words.filter((w) => w.text.trim()).forEach((w, k) => {
          if (w.confidence >= SUSPECT_BELOW || !/[\p{L}\p{N}]/u.test(w.text)) return;
          const choices = [...new Set((w.choices ?? []).map((c) => c.text.trim()).filter((c) => c && c !== w.text.trim()))].slice(0, 4);
          suspects.push({ page: i, line: lines.length, word: k, text: w.text.trim(), image: crop(canvas, w.bbox), choices });
        });
        lines.push({ text: t, x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), words });
      }
      out.set(i, lines);
      progress((n + 1) / pages.length);
    }
  } finally {
    await worker.terminate();
  }
  return out;
}

/** A picture of a word from the rendered page, with a little of the line around it. */
function crop(canvas: HTMLCanvasElement, b: { x0: number; y0: number; x1: number; y1: number }): string {
  const pad = Math.round((b.y1 - b.y0) * 0.6);
  const x = Math.max(0, b.x0 - pad * 2), y = Math.max(0, b.y0 - pad);
  const w = Math.min(canvas.width - x, b.x1 - b.x0 + pad * 4), h = Math.min(canvas.height - y, b.y1 - b.y0 + pad * 2);
  const c = document.createElement('canvas');
  c.width = Math.max(1, w); c.height = Math.max(1, h);
  c.getContext('2d')!.drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return c.toDataURL('image/png');
}

/** Puts the reviewed words back into their lines. */
export function applyCorrections(results: Map<number, OcrLine[]>, suspects: Suspect[], corrected: string[]) {
  suspects.forEach((s, n) => {
    const line = results.get(s.page)?.[s.line];
    if (!line?.words?.[s.word] || corrected[n] === undefined) return;
    line.words[s.word].text = corrected[n].trim();
    line.text = line.words.map((w) => w.text).filter(Boolean).join(' ');
  });
  for (const [p, lines] of results) results.set(p, lines.filter((l) => l.text.trim()));
}

/** Writes recognised lines as invisible text, stretched to cover each line's box. */
export async function addTextLayer(doc: PDFDocument, results: Map<number, OcrLine[]>) {
  for (const [i, lines] of results) {
    if (!lines.length) continue;
    const page = doc.getPage(i);
    for (const l of lines) {
      const font = await fontFor(doc, { family: 'Helvetica', bold: false, italic: false, text: l.text });
      const key = page.node.newFontDictionary(hasArabic(l.text) ? 'MKOcrA' : 'MKOcr', font.ref);
      // The size that fills the line's width (as on the Mac): a box's height swings with ascenders and descenders,
      // so it only bounds sizes far off it. Edited text then matches the scan's own size.
      const perPoint = font.widthOfTextAtSize(l.text, 1);
      const size = Math.min(l.h * 1.15, Math.max(l.h * 0.5, perPoint > 0 ? l.w / perPoint : l.h * 0.85));
      const natural = font.widthOfTextAtSize(l.text, size) || 1;
      page.pushOperators(
        beginText(), setFontAndSize(key, size), setTextRenderingMode(TextRenderingMode.Invisible),
        setCharacterSqueeze(Math.max(10, Math.min(500, (l.w / natural) * 100))), setTextMatrix(1, 0, 0, 1, l.x, l.y + l.h * 0.18),
        showText(font.encodeText(l.text)), endText(),
      );
    }
  }
}
