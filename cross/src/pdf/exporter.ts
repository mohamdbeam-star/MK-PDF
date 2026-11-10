// Turns a document into other formats using the layout model, with pdf.js rendering for pictures.
import { PDFDocument } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { LayoutItem, layoutPage, PageLayout } from '../engine/layout';
import { pageTextItems } from '../engine/textItems';
import { PageContent, Rect, contains, union } from '../engine/pageContent';
import { Assets, csv, docx, html, markdown, odt, plainText, pptx, rtf, xlsx } from '../export/writers';
import { canvasBytes, renderPage } from './render';
import { openPdfjs } from './doc';
import { loadPdf } from '../engine/load';
import { pdfComments } from '../export/comments';

export type DocFormat = 'docx' | 'doc' | 'odt' | 'xlsx' | 'pptx' | 'html' | 'md' | 'txt' | 'csv' | 'rtf';
export const DOC_FORMATS: { id: DocFormat; title: string; detail: string }[] = [
  { id: 'docx', title: 'Word (.docx)', detail: 'Editable paragraphs, tables and images' },
  { id: 'doc', title: 'Word 97 (.doc)', detail: 'For older versions of Word' },
  { id: 'odt', title: 'OpenDocument (.odt)', detail: 'LibreOffice and other office apps' },
  { id: 'xlsx', title: 'Excel (.xlsx)', detail: 'Tables keep their columns; one sheet per page' },
  { id: 'pptx', title: 'PowerPoint (.pptx)', detail: 'Editable text over each page' },
  { id: 'html', title: 'Web page (.html)', detail: 'Exact layout, selectable text' },
  { id: 'rtf', title: 'Rich Text (.rtf)', detail: 'Styled text and tables' },
  { id: 'md', title: 'Markdown (.md)', detail: 'Headings, lists and tables' },
  { id: 'txt', title: 'Plain text (.txt)', detail: '' },
  { id: 'csv', title: 'CSV (.csv)', detail: '' },
];
export const MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', odt: 'application/vnd.oasis.opendocument.text',
  html: 'text/html', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', rtf: 'application/rtf', pdf: 'application/pdf',
};

export async function layouts(bytes: Uint8Array, js: PDFDocumentProxy): Promise<{ doc: PDFDocument; pages: PageLayout[] }> {
  const doc = await loadPdf(bytes);
  const pages: PageLayout[] = [];
  for (let i = 0; i < doc.getPageCount(); i++) pages.push(layoutPage(doc, i, await pageTextItems(js, i + 1)));
  return { doc, pages };
}

function assetsFor(doc: PDFDocument, js: PDFDocumentProxy): Assets {
  const renders = new Map<number, Promise<HTMLCanvasElement>>();
  const render = (i: number) => { if (!renders.has(i)) renders.set(i, renderPage(js, i, 2, { annotations: true })); return renders.get(i)!; };
  const arts = new Map<number, Promise<HTMLCanvasElement>>();
  const art = (i: number) => { if (!arts.has(i)) arts.set(i, textless().then((t) => renderPage(t, i, 2))); return arts.get(i)!; };
  let stripped: Promise<PDFDocumentProxy> | null = null;
  const textless = () => (stripped ??= (async () => {
    const copy = await loadPdf(await doc.save());
    for (const page of copy.getPages()) { const pc = new PageContent(copy, page); pc.removeGlyphs((g) => !g.invisible); pc.commit(); }
    return openPdfjs(await copy.save());
  })());
  return {
    async image(page, item) {
      const obj = (item as { object?: import('../engine/pageContent').GraphicObject }).object;
      if (obj && !item.composite) {
        const info = new PageContent(doc, doc.getPage(page)).imageStream(obj);
        if (info?.jpeg) return { data: info.stream.getContents(), ext: 'jpeg' };
      }
      // Stacked or transparent pictures: the area as the page shows it, without its text (Word has that).
      const canvas = item.composite ? await art(page) : await render(page);
      const pg = await js.getPage(page + 1);
      const vp = pg.getViewport({ scale: 2 });
      const r = item.rect as Rect;
      const [a, b] = [vp.convertToViewportPoint(r.x, r.y + r.h), vp.convertToViewportPoint(r.x + r.w, r.y)];
      const x = Math.max(0, Math.min(a[0], b[0])), y = Math.max(0, Math.min(a[1], b[1]));
      const w = Math.min(canvas.width - x, Math.abs(b[0] - a[0])), h = Math.min(canvas.height - y, Math.abs(b[1] - a[1]));
      if (w < 2 || h < 2) return null;
      const cut = document.createElement('canvas');
      cut.width = Math.round(w); cut.height = Math.round(h);
      cut.getContext('2d')!.drawImage(canvas, x, y, w, h, 0, 0, w, h);
      return { data: await canvasBytes(cut, 'image/png'), ext: 'png' };
    },
    async background(page, keepText) {
      const source = keepText ? js : await textless();
      return canvasBytes(await renderPage(source, page, 150 / 72), 'image/jpeg', 0.85);
    },
  };
}

/**
 * Part of one page as Word (flowing text), Excel or CSV: the lines, tables and pictures whose middle is inside
 * `area` (page space). Null when nothing is there.
 */
export async function exportArea(bytes: Uint8Array, js: PDFDocumentProxy, page: number, area: Rect, format: 'docx' | 'xlsx' | 'csv'): Promise<Uint8Array | null> {
  const doc = await loadPdf(bytes);
  const full = layoutPage(doc, page, await pageTextItems(js, page + 1));
  const inside = (r: Rect) => contains(area, { x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const items = full.items.flatMap((it): LayoutItem[] => {
    if (it.kind !== 'paragraph') return inside(it.rect) ? [it] : [];
    const lines = it.lines.filter((l) => inside(l.rect));
    return lines.length ? [{ ...it, lines, rect: lines.reduce<Rect>((a, l) => union(a, l.rect)!, lines[0].rect) }] : [];
  });
  if (!items.length) return null;
  const part: PageLayout = { ...full, items, boxes: [], columns: [], rules: full.rules.filter((r) => inside(r.rect)) };
  if (format === 'docx') return docx([part], assetsFor(doc, js), { flow: true });
  if (format === 'xlsx') return xlsx([part]);
  return new TextEncoder().encode(csv([part]));
}

export async function exportDocument(bytes: Uint8Array, js: PDFDocumentProxy, format: DocFormat, title: string, opts: { flow?: boolean; images?: boolean; comments?: boolean } = {}): Promise<Uint8Array> {
  const { doc, pages: all } = await layouts(bytes, js);
  const pages = opts.images === false ? all.map((p) => ({ ...p, items: p.items.filter((i) => i.kind !== 'image') })) : all;
  const assets = assetsFor(doc, js);
  const enc = (s: string) => new TextEncoder().encode(s);
  switch (format) {
    case 'docx': return docx(pages, assets, { flow: opts.flow, comments: opts.comments === false ? [] : pdfComments(doc) });
    case 'pptx': return pptx(pages, assets);
    case 'html': return html(pages, title, assets);
    case 'xlsx': return xlsx(pages);
    case 'md': return enc(await markdown(pages, assets));
    case 'txt': return enc(plainText(pages));
    case 'csv': return enc(csv(pages));
    case 'rtf': return enc(rtf(pages));
    // Word opens rich text saved as .doc, as older Word versions expect from a .doc file.
    case 'doc': return enc(rtf(pages));
    case 'odt': return odt(pages);
  }
}

export async function exportImages(js: PDFDocumentProxy, type: 'png' | 'jpeg' | 'webp', dpi: number, quality: number, pages?: number[]): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const i of pages ?? [...Array(js.numPages).keys()]) out.push(await canvasBytes(await renderPage(js, i, dpi / 72), `image/${type}`, quality));
  return out;
}
