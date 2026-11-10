// The PDF's comments for an export (no browser APIs: the Mac app's built-in converter uses it too).
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import type { Rect } from '../engine/pageContent';

export interface ExportComment { page: number; rect: Rect; author: string; text: string; date?: string }

const KINDS = new Set(['Text', 'FreeText', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Caret', 'Square', 'Circle', 'Ink', 'Stamp', 'Line', 'Polygon', 'PolyLine']);

/** Comments with text: sticky notes, text boxes, and markup or shapes someone wrote a note on. */
export function pdfComments(doc: PDFDocument): ExportComment[] {
  const out: ExportComment[] = [];
  const byRef = new Map<string, ExportComment>();
  const replies: { to: string; author: string; text: string }[] = [];
  const str = (d: PDFDict, k: string) => { const v = d.lookup(PDFName.of(k)); return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : ''; };
  doc.getPages().forEach((page, i) => {
    const annots = page.node.Annots();
    for (let k = 0; k < (annots?.size() ?? 0); k++) {
      const a = annots!.lookup(k);
      if (!(a instanceof PDFDict)) continue;
      const kind = a.lookup(PDFName.of('Subtype'));
      if (!(kind instanceof PDFName) || !KINDS.has(kind.decodeText())) continue;
      const text = str(a, 'Contents').trim();
      // A reply joins the thread of the comment it answers (added below, once every comment is known).
      const irt = a.get(PDFName.of('IRT'));
      if (irt instanceof PDFRef) { if (text) replies.push({ to: irt.toString(), author: str(a, 'T') || 'Reply', text }); continue; }
      const r = a.lookup(PDFName.of('Rect'));
      if (!text || !(r instanceof PDFArray)) continue;
      const [x0, y0, x1, y1] = [0, 1, 2, 3].map((n) => (r.lookup(n) as PDFNumber | undefined)?.asNumber() ?? 0);
      const date = /^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/.exec(str(a, 'M') || str(a, 'CreationDate'));
      const raw = annots!.get(k);
      const c: ExportComment = {
        page: i, rect: { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) },
        author: str(a, 'T') || 'Comment', text,
        ...(date ? { date: `${date[1]}-${date[2]}-${date[3]}T${date[4] ?? '00'}:${date[5] ?? '00'}:${date[6] ?? '00'}Z` } : {}),
      };
      out.push(c);
      if (raw instanceof PDFRef) byRef.set(raw.toString(), c);
    }
  });
  for (const r of replies) { const parent = byRef.get(r.to); if (parent) parent.text += `\n${r.author}: ${r.text}`; }
  return out;
}
