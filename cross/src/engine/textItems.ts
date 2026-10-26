// pdf.js text content → page-space text items for the layout model.
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem } from './layout';

export async function pageTextItems(doc: PDFDocumentProxy, pageNumber: number): Promise<TextItem[]> {
  const page = await doc.getPage(pageNumber);
  const tc = await page.getTextContent();
  const out: TextItem[] = [];
  for (const it of tc.items as { str?: string; transform: number[]; width: number; height: number; dir?: string }[]) {
    // Some fonts map glyphs (often Arabic joining forms) to control characters; they're never real text.
    const str = it.str?.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (!str) continue;
    const t = it.transform;
    out.push({ str, x: t[4], y: t[5], w: it.width, h: it.height || Math.hypot(t[2], t[3]), rtl: it.dir === 'rtl' });
  }
  return out;
}
