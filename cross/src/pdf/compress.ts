// Compression: lossless restructuring (qpdf) plus optional re-encoding of photos as smaller JPEGs.
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib';
import { optimize } from './security';
import { loadPdf } from '../engine/load';

export type Preset = 'lossless' | 'balanced' | 'strong' | 'maximum';
export const PRESETS: { id: Preset; title: string; detail: string }[] = [
  { id: 'lossless', title: 'Lossless', detail: 'Restructures and recompresses the file. Nothing visible changes.' },
  { id: 'balanced', title: 'Balanced (recommended)', detail: 'Large photos re-encoded as JPEG (up to 2000 px, quality 75). Text stays sharp and selectable.' },
  { id: 'strong', title: 'Strong', detail: 'Photos down to 1300 px at quality 60. Text stays selectable.' },
  { id: 'maximum', title: 'Maximum', detail: 'Photos down to 900 px at quality 45. Smallest file.' },
];

async function recodeImage(stream: PDFRawStream, maxSide: number, quality: number): Promise<Uint8Array | null> {
  const d = stream.dict;
  const w = (d.lookup(PDFName.of('Width')) as PDFNumber | undefined)?.asNumber() ?? 0;
  const h = (d.lookup(PDFName.of('Height')) as PDFNumber | undefined)?.asNumber() ?? 0;
  if (w * h < 200 * 200 || d.has(PDFName.of('SMask')) || d.has(PDFName.of('Mask')) || d.lookup(PDFName.of('ImageMask'))) return null;
  const filter = d.lookup(PDFName.of('Filter'));
  const isJpeg = filter instanceof PDFName && filter.decodeText() === 'DCTDecode';
  let bitmap: ImageBitmap | ImageData;
  if (isJpeg) bitmap = await createImageBitmap(new Blob([stream.getContents() as BlobPart], { type: 'image/jpeg' }));
  else {
    const { decodePDFRawStream } = await import('pdf-lib');
    const cs = d.lookup(PDFName.of('ColorSpace'));
    const bpc = (d.lookup(PDFName.of('BitsPerComponent')) as PDFNumber | undefined)?.asNumber();
    const name = cs instanceof PDFName ? cs.decodeText() : '';
    if (bpc !== 8 || (name !== 'DeviceRGB' && name !== 'DeviceGray')) return null;
    let raw: Uint8Array;
    try { raw = decodePDFRawStream(stream).decode(); } catch { return null; }
    const comps = name === 'DeviceRGB' ? 3 : 1;
    if (raw.length < w * h * comps) return null;
    const img = new ImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      img.data[i * 4] = raw[i * comps]; img.data[i * 4 + 1] = raw[i * comps + (comps - 1 ? 1 : 0)]; img.data[i * 4 + 2] = raw[i * comps + (comps - 1 ? 2 : 0)]; img.data[i * 4 + 3] = 255;
    }
    bitmap = img;
  }
  const s = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext('2d')!;
  if (bitmap instanceof ImageData) {
    const tmp = new OffscreenCanvas(w, h);
    tmp.getContext('2d')!.putImageData(bitmap, 0, 0);
    ctx.drawImage(tmp, 0, 0, cw, ch);
  } else ctx.drawImage(bitmap, 0, 0, cw, ch);
  const out = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
  return out.length < stream.getContents().length * 0.9 ? Object.assign(out, { w: cw, h: ch }) : null;
}

export async function compress(bytes: Uint8Array, preset: Preset, progress: (p: number) => void = () => {}): Promise<Uint8Array> {
  let data = bytes;
  if (preset !== 'lossless') {
    const doc = await loadPdf(bytes, { updateMetadata: false });
    const [maxSide, quality] = preset === 'balanced' ? [2000, 0.75] : preset === 'strong' ? [1300, 0.6] : [900, 0.45];
    const images = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && (o.dict.lookup(PDFName.of('Subtype')) as PDFName | undefined)?.decodeText() === 'Image') as [PDFRef, PDFRawStream][];
    for (const [n, [ref, stream]] of images.entries()) {
      const jpeg = await recodeImage(stream, maxSide, quality).catch(() => null) as (Uint8Array & { w: number; h: number }) | null;
      if (jpeg) {
        const dict = { Type: 'XObject', Subtype: 'Image', Width: jpeg.w, Height: jpeg.h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' };
        doc.context.assign(ref, doc.context.stream(jpeg, dict as never));
      }
      progress(((n + 1) / Math.max(images.length, 1)) * 0.8);
    }
    data = await doc.save({ useObjectStreams: true });
  }
  const optimized = await optimize(data);
  progress(1);
  return optimized.length < data.length ? optimized : data;
}
