// Loading PDFs into pdf-lib safely.
import { CustomFontEmbedder, PDFDocument, type LoadOptions, type PDFContext, type PDFRef } from 'pdf-lib';

/**
 * Some fonts draw a letter as a base shape plus a separate mark glyph that stands for no character (Noto Naskh
 * writes ب as a dotless beh and a dot). pdf-lib maps such glyphs to nothing, and readers then put the glyph's code
 * in the text instead, so copying or searching "مرحبا" finds "مرحب\u0002ا". A zero-width joiner, which readers drop,
 * keeps the text clean.
 */
type Embedder = { glyphCache: { access(): { codePoints: number[] }[] }; embedUnicodeCmap(context: PDFContext): PDFRef };
const proto = CustomFontEmbedder.prototype as unknown as Embedder;
const embedCmap = proto.embedUnicodeCmap;
proto.embedUnicodeCmap = function (this: Embedder, context: PDFContext) {
  const marks = this.glyphCache.access().filter((g) => g && !g.codePoints.length);
  marks.forEach((g) => (g.codePoints = [0x200d]));
  try { return embedCmap.call(this, context); } finally { marks.forEach((g) => (g.codePoints = [])); }
};

const find = (b: Uint8Array, s: string, from = 0, back = false): number => {
  const pat = Array.from(s, (c) => c.charCodeAt(0));
  const match = (i: number) => pat.every((p, k) => b[i + k] === p);
  if (back) { for (let i = Math.min(from, b.length - pat.length); i >= 0; i--) if (match(i)) return i; return -1; }
  for (let i = from; i <= b.length - pat.length; i++) if (match(i)) return i;
  return -1;
};

/**
 * pdf-lib reads every object in the file, including object streams the file no longer uses. Some writers
 * (PDFKit among them) renumber objects on save but keep the old object streams, whose stale copies would then
 * replace the real objects. When the file's final cross-reference is a plain table with no stream part, no
 * object stream is in use, so they are renamed out of pdf-lib's way.
 */
export function withoutStaleObjectStreams(bytes: Uint8Array): Uint8Array {
  const sx = find(bytes, 'startxref', bytes.length, true);
  if (sx < 0) return bytes;
  const m = /startxref\s+(\d+)/.exec(String.fromCharCode(...bytes.subarray(sx, Math.min(bytes.length, sx + 40))));
  const at = m ? Number(m[1]) : -1;
  if (at < 0 || at >= bytes.length || find(bytes.subarray(at, at + 8), 'xref') !== 0) return bytes;
  const trailer = find(bytes, 'trailer', at);
  if (trailer < 0 || find(bytes.subarray(trailer, Math.min(bytes.length, trailer + 4096)), '/XRefStm') >= 0) return bytes;
  // Earlier revisions (incremental updates) may still rely on object streams.
  if (find(bytes.subarray(trailer, Math.min(bytes.length, trailer + 4096)), '/Prev') >= 0) return bytes;
  let out: Uint8Array | null = null;
  for (let i = find(bytes, '/ObjStm'); i >= 0; i = find(bytes, '/ObjStm', i + 7)) {
    out ??= bytes.slice();
    out[i + 1] = 'X'.charCodeAt(0); // "/XbjStm": an ordinary stream to pdf-lib
  }
  return out ?? bytes;
}

export function loadPdf(bytes: Uint8Array, options: LoadOptions = {}): Promise<PDFDocument> {
  return PDFDocument.load(withoutStaleObjectStreams(bytes), { ignoreEncryption: true, ...options });
}
