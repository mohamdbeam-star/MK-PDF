// Saved signatures/initials (kept on this device) and rubber-stamp images.
import { signal } from '@preact/signals';

export interface SavedSignature { id: string; kind: string; png: Uint8Array; url: string; w: number; h: number }

const KEY = 'mkpdf.signatures';
const toB64 = (b: Uint8Array) => { let s = ''; for (const c of b) s += String.fromCharCode(c); return btoa(s); };
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function load(): SavedSignature[] {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as { id: string; kind: string; png: string; w: number; h: number }[])
      .map((s) => ({ ...s, png: fromB64(s.png), url: `data:image/png;base64,${s.png}` }));
  } catch { return []; }
}

export const signatures = signal<SavedSignature[]>(load());

function persist() {
  localStorage.setItem(KEY, JSON.stringify(signatures.value.map((s) => ({ id: s.id, kind: s.kind, png: toB64(s.png), w: s.w, h: s.h }))));
}

export function addSignature(kind: string, png: Uint8Array, w: number, h: number): SavedSignature {
  const s = { id: crypto.randomUUID(), kind, png, url: `data:image/png;base64,${toB64(png)}`, w, h };
  signatures.value = [...signatures.value, s];
  persist();
  return s;
}

export function deleteSignature(id: string) {
  signatures.value = signatures.value.filter((s) => s.id !== id);
  persist();
}

export const STAMPS = [
  { title: 'APPROVED', color: '#1f9d55' }, { title: 'NOT APPROVED', color: '#d32f2f' }, { title: 'DRAFT', color: '#1e66f5' },
  { title: 'FINAL', color: '#1f9d55' }, { title: 'CONFIDENTIAL', color: '#d32f2f' }, { title: 'FOR COMMENT', color: '#1e66f5' },
  { title: 'REVIEWED', color: '#5b4fd6' }, { title: 'RECEIVED', color: '#0f8b8d' }, { title: 'VOID', color: '#d32f2f' },
  { title: 'PAID', color: '#1f9d55' }, { title: 'SIGN HERE', color: '#ef6c00' }, { title: 'COPY', color: '#666666' },
];

const canvasPng = (c: HTMLCanvasElement) => new Promise<Uint8Array>((r) => c.toBlob((b) => b!.arrayBuffer().then((a) => r(new Uint8Array(a))), 'image/png'));

/** An image file to place, or a stamp rendered with the author and date. Sizes are in points. */
export async function stampImage(file: Uint8Array | null, stamp?: { title: string; color: string }, author?: string): Promise<{ png: Uint8Array; w: number; h: number }> {
  if (file) {
    const bmp = await createImageBitmap(new Blob([file as BlobPart]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    return { png: await canvasPng(c), w: bmp.width * 0.75, h: bmp.height * 0.75 };
  }
  const s = stamp!;
  const scale = 3;
  const detail = `${author} · ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `900 ${44 * scale}px system-ui, sans-serif`;
  const tw = ctx.measureText(s.title).width;
  ctx.font = `600 ${18 * scale}px system-ui, sans-serif`;
  const dw = ctx.measureText(detail).width;
  c.width = Math.max(tw, dw) + 48 * scale;
  c.height = (44 + 18 + 40) * scale;
  ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = 5 * scale;
  ctx.beginPath(); ctx.roundRect(4 * scale, 4 * scale, c.width - 8 * scale, c.height - 8 * scale, 12 * scale); ctx.stroke();
  ctx.globalAlpha = 0.06; ctx.fill(); ctx.globalAlpha = 1;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = `900 ${44 * scale}px system-ui, sans-serif`;
  ctx.fillText(s.title, c.width / 2, 54 * scale);
  ctx.font = `600 ${18 * scale}px system-ui, sans-serif`;
  ctx.fillText(detail, c.width / 2, 86 * scale);
  return { png: await canvasPng(c), w: c.width / scale, h: c.height / scale };
}
