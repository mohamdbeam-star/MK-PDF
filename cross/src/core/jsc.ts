// Entry point for the Mac app, which runs the conversion core in JavaScriptCore (no DOM, no event loop).
// The app passes the PDF and its page text (read with PDFKit) and draws pictures natively on request.
import { PageContent, type GraphicObject } from '../engine/pageContent';
import type { PageText, TextItem } from '../engine/layout';
import { convertLayouts, layoutsFor, type DocFormat } from './convert';

declare const nativeRender: (page: number, x: number, y: number, w: number, h: number) => string | null;
declare const nativeBackground: (page: number, keepText: boolean) => string | null;
declare const nativeTextIn: ((page: number, x: number, y: number, w: number, h: number) => string | null) | undefined;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
    out[o++] = (n >> 16) & 255;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}
function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return s;
}

export async function convert(pdf: string, pagesJSON: string, format: DocFormat, title: string): Promise<string> {
  const bytes = fromBase64(pdf);
  // Page text: the app's lookup by rect when it offers one, else the text items it passed.
  const text = pagesJSON ? (JSON.parse(pagesJSON) as TextItem[][]) : [];
  const source = (i: number): PageText => (typeof nativeTextIn === 'function'
    ? { textIn: (r) => nativeTextIn(i, r.x, r.y, r.w, r.h) ?? '' } : text[i] ?? []);
  const { doc, pages } = await layoutsFor(bytes, source);
  const out = await convertLayouts(pages, format, title, {
    async image(page, item) {
      const obj = (item as { object?: GraphicObject }).object;
      const info = obj ? new PageContent(doc, doc.getPage(page)).imageStream(obj) : null;
      if (info?.jpeg) return { data: info.stream.getContents(), ext: 'jpeg' };
      const r = item.rect;
      const png = nativeRender(page, r.x, r.y, r.w, r.h);
      return png ? { data: fromBase64(png), ext: 'png' } : null;
    },
    async background(page, keepText) {
      const jpg = nativeBackground(page, keepText);
      return jpg ? fromBase64(jpg) : null;
    },
  });
  return toBase64(out);
}

(globalThis as unknown as { MKPDFCore: unknown }).MKPDFCore = { convert, fromBase64, toBase64 };
