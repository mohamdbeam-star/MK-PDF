// The conversion core shared by every app: PDF bytes + page text → Word, Excel, PowerPoint, HTML, Markdown,
// text, CSV or RTF. It needs no DOM, so it runs in the web view (Windows, Android), in Node (tests) and in
// JavaScriptCore inside the Mac app, which supplies the page text and pictures natively.
import { PDFDocument } from 'pdf-lib';
import { PageLayout, PageText, layoutPage } from '../engine/layout';
import { Assets, csv, docx, html, markdown, odt, plainText, pptx, rtf, xlsx } from '../export/writers';
import { loadPdf } from '../engine/load';

export type DocFormat = 'docx' | 'doc' | 'odt' | 'xlsx' | 'pptx' | 'html' | 'md' | 'txt' | 'csv' | 'rtf';

export async function layoutsFor(bytes: Uint8Array, text: (page: number) => Promise<PageText> | PageText, pages?: number[]): Promise<{ doc: PDFDocument; pages: PageLayout[] }> {
  const doc = await loadPdf(bytes);
  const out: PageLayout[] = [];
  for (const i of pages ?? [...Array(doc.getPageCount()).keys()]) out.push(layoutPage(doc, i, await text(i)));
  return { doc, pages: out };
}

const none: Assets = { image: async () => null, background: async () => null };

export async function convertLayouts(all: PageLayout[], format: DocFormat, title: string, assets: Assets = none): Promise<Uint8Array> {
  const enc = (s: string) => new TextEncoder().encode(s);
  // A scan's page image goes behind its recognised text only in Word, and only where the app paints that text out.
  const pages = format === 'docx' && assets.scanBackground ? all
    : all.map((p) => ({ ...p, items: p.items.filter((i) => !(i.kind === 'image' && i.scan)) }));
  switch (format) {
    case 'docx': return docx(pages, assets);
    case 'pptx': return pptx(pages, assets);
    case 'html': return html(pages, title, assets);
    case 'xlsx': return xlsx(pages);
    case 'md': return enc(await markdown(pages, assets));
    case 'txt': return enc(plainText(pages));
    case 'csv': return enc(csv(pages));
    case 'rtf': return enc(rtf(pages));
    case 'doc': return enc(rtf(pages));
    case 'odt': return odt(pages);
  }
}
