// Rendering pages with pdf.js (thumbnails, image export, OCR input, backgrounds).
import type { PDFDocumentProxy } from 'pdfjs-dist';

export async function renderPage(doc: PDFDocumentProxy, index: number, scale: number, opts: { annotations?: boolean } = {}): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(index + 1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport, annotationMode: opts.annotations === false ? 0 : 1 } as never).promise;
  return canvas;
}

export function canvasBytes(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.88): Promise<Uint8Array> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a))) : reject(new Error(`This device can't write ${type}.`))), type, quality));
}
