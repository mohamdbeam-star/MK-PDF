// Offline OCR with tesseract.js: recognised lines become invisible, selectable text over the scan.
import { createWorker, OEM } from 'tesseract.js';
import { PDFDocument, TextRenderingMode, beginText, endText, setCharacterSqueeze, setFontAndSize, setTextMatrix, setTextRenderingMode, showText } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { renderPage } from './render';
import { fontFor, hasArabic } from './fonts';

export interface OcrLine { text: string; x: number; y: number; w: number; h: number } // page space

const base = (p: string) => new URL(p, document.baseURI).href;

export async function recognize(js: PDFDocumentProxy, pages: number[], languages: string, progress: (p: number) => void): Promise<Map<number, OcrLine[]>> {
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
        lines.push({ text: t, x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });
      }
      out.set(i, lines);
      progress((n + 1) / pages.length);
    }
  } finally {
    await worker.terminate();
  }
  return out;
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
