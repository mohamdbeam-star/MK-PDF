// Fonts for text that MK PDF draws (edited text, text boxes, page numbers, OCR layers).
// Order: the matching installed font (Windows Fonts folder via the desktop shell), then bundled Noto.
import fontkit from '@pdf-lib/fontkit';
import { StandardFonts, type PDFDocument, type PDFFont } from 'pdf-lib';
import { platform } from '../app/platform';

const cache = new Map<string, Promise<Uint8Array | null>>();
const bundled = (file: string) => {
  if (!cache.has(file)) cache.set(file, fetch(new URL(`fonts/${file}`, document.baseURI)).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Uint8Array(b) : null)).catch(() => null));
  return cache.get(file)!;
};

export interface FontRequest { family: string; bold: boolean; italic: boolean; mono?: boolean; text: string }

export const hasArabic = (s: string) => /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(s);

function covers(bytes: Uint8Array, text: string): boolean {
  try {
    const f = fontkit.create(bytes as never) as unknown as { glyphForCodePoint(c: number): { id: number } };
    for (const ch of text) { const c = ch.codePointAt(0)!; if (c > 32 && f.glyphForCodePoint(c).id === 0) return false; }
    return true;
  } catch { return false; }
}

function bundledFile(r: FontRequest): string {
  const style = r.bold && r.italic ? 'BoldItalic' : r.bold ? 'Bold' : r.italic ? 'Italic' : 'Regular';
  if (hasArabic(r.text)) return `NotoNaskhArabic-${r.bold ? 'Bold' : 'Regular'}.ttf`;
  const f = r.family.toLowerCase();
  if (r.mono || /courier|mono|consol/.test(f)) return `NotoSansMono-${r.bold ? 'Bold' : 'Regular'}.ttf`;
  if (/times|serif|georgia|garamond|cambria|book|roman/.test(f) && !f.includes('sans')) return `NotoSerif-${style}.ttf`;
  return `NotoSans-${style}.ttf`;
}

/** The built-in PDF font matching a Helvetica/Arial, Times or Courier family, if any. */
function standardFont(r: FontRequest): StandardFonts | null {
  const f = r.family.toLowerCase();
  const pick = (base: 'Helvetica' | 'Courier' | 'Times') => {
    const slant = base === 'Times' ? 'Italic' : 'Oblique';
    const suffix = r.bold && r.italic ? `Bold${slant}` : r.bold ? 'Bold' : r.italic ? slant : base === 'Times' ? 'Roman' : '';
    return (suffix ? `${base}-${suffix}` : base) as StandardFonts;
  };
  if (/helvetica|arial/.test(f)) return pick('Helvetica');
  if (/times/.test(f)) return pick('Times');
  if (/courier/.test(f)) return pick('Courier');
  return null;
}

const installed = (r: FontRequest) => platform.systemFont?.(r.family, r.bold, r.italic).then((s) => (s && covers(s, r.text) ? s : null)) ?? Promise.resolve(null);

/** Font bytes for a request: installed match when it has every character, else bundled Noto. */
export async function fontBytes(r: FontRequest): Promise<Uint8Array> {
  const system = await installed(r);
  if (system) return system;
  const b = await bundled(bundledFile(r));
  if (!b) throw new Error('Font files are missing from the app.');
  return b;
}

const embedded = new WeakMap<PDFDocument, Map<string, PDFFont>>();

/** Embeds (once per document) the best font for `r`. */
export async function fontFor(doc: PDFDocument, r: FontRequest): Promise<PDFFont> {
  doc.registerFontkit(fontkit);
  // Without the installed font, the built-in PDF font keeps Helvetica/Times/Courier text metrically identical.
  const std = standardFont(r);
  if (std && !(await installed(r))) {
    try { const f = await doc.embedFont(std); f.encodeText(r.text); return f; } catch { /* has characters outside WinAnsi */ }
  }
  const bytes = await fontBytes(r);
  const key = `${bytes.length}:${bytes[100]}:${bytes[1000]}`;
  let m = embedded.get(doc);
  if (!m) { m = new Map(); embedded.set(doc, m); }
  if (!m.has(key)) m.set(key, await doc.embedFont(bytes, { subset: true }));
  return m.get(key)!;
}

/** Splits text into lines no wider than `width` (explicit newlines kept). */
export function wrap(text: string, font: PDFFont, size: number, width?: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!width) { out.push(para); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (line && font.widthOfTextAtSize(next.trimEnd(), size) > width) { out.push(line.trimEnd()); line = word.trimStart(); }
      else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}
