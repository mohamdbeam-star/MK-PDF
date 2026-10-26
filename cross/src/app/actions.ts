// User-level actions: each one gathers input, runs a PDF operation as an undoable step and reports back.
import { PDFDocument } from 'pdf-lib';
import { platform } from './platform';
import {
  active, docs, editObject, newDocument, openDocument, organizing, pageIndex, prompt, selectedAnnot, showToast, task,
} from './store';
import * as ops from '../pdf/ops';
import * as annots from '../pdf/annots';
import * as editing from '../pdf/editing';
import { compress as compressBytes, Preset } from '../pdf/compress';
import { repair as repairBytes } from '../pdf/security';
import { DOC_FORMATS, DocFormat, MIME, exportDocument, exportImages } from '../pdf/exporter';
import { addTextLayer, recognize } from '../pdf/ocr';
import { renderPage, canvasBytes } from '../pdf/render';
import { loadPdf } from '../engine/load';

const base = (name: string) => name.replace(/\.pdf$/i, '');
const pdfAccept = 'application/pdf,.pdf';
const imageAccept = 'image/*';

export async function openFiles() {
  for (const f of await platform.openFiles(pdfAccept, true)) await openDocument(f);
}

export async function createBlank() {
  const doc = await PDFDocument.create();
  doc.addPage(ops.A4);
  await newDocument('Untitled.pdf', await doc.save());
}

export async function combineFiles(files?: { name: string; bytes: Uint8Array }[]) {
  const list = files ?? await platform.openFiles(`${pdfAccept},${imageAccept}`, true);
  if (!list.length) return;
  const bytes = await task('Combining…', () => ops.combine(list));
  if (bytes) await newDocument('Combined.pdf', bytes);
}

export async function imagesToPdf(capture = false) {
  const list = await platform.openFiles(imageAccept, true, capture);
  if (!list.length) return;
  const bytes = await task('Creating PDF…', () => ops.combine(list, ops.A4));
  if (bytes) await newDocument(capture ? 'Scan.pdf' : 'Images.pdf', bytes);
}

export async function repairFile() {
  const [f] = await platform.openFiles(pdfAccept, false);
  if (!f) return;
  const bytes = await task('Repairing…', () => repairBytes(f.bytes));
  if (bytes) { await newDocument(`${base(f.name)} (repaired).pdf`, bytes); showToast('Rebuilt the file structure. Save to keep the repaired copy.'); }
}

/** Runs an edit on the active document. */
export async function edit(label: string, fn: (doc: PDFDocument) => Promise<void> | void) {
  const d = active.value;
  if (!d) return;
  selectedAnnot.value = null;
  editObject.value = null;
  await task(label.endsWith('…') ? label : `${label}…`, () => d.apply(label, fn));
}

export const undo = () => active.value?.undo();
export const redo = () => active.value?.redo();

export async function exportAs(format: DocFormat, ocr: boolean) {
  const d = active.value;
  if (!d?.js) return;
  const info = DOC_FORMATS.find((f) => f.id === format)!;
  const result = await task(`Converting to ${info.title.split(' ')[0]}…`, async (progress) => {
    let bytes = await d.currentBytes();
    let js = d.js!;
    if (ocr) {
      const scanned: number[] = [];
      for (let i = 0; i < js.numPages; i++) {
        const tc = await (await js.getPage(i + 1)).getTextContent();
        if (!tc.items.some((it) => 'str' in it && it.str.trim())) scanned.push(i);
      }
      if (scanned.length) {
        const results = await recognize(js, scanned, 'eng+ara', (p) => progress(p * 0.7));
        const doc = await loadPdf(bytes);
        await addTextLayer(doc, results);
        bytes = await doc.save();
        js = await (await import('../pdf/doc')).openPdfjs(bytes);
      }
    }
    return exportDocument(bytes, js, format, base(d.name));
  });
  if (!result) return;
  const saved = await platform.saveFile(`${base(d.name)}.${format}`, result, MIME[format]);
  if (saved) { showToast(`Exported to ${saved.label}`); platform.notify('Export finished', saved.label); }
}

export async function exportPageImages(type: 'png' | 'jpeg' | 'webp', dpi: number, quality: number) {
  const d = active.value;
  if (!d?.js) return;
  const images = await task('Exporting images…', () => exportImages(d.js!, type, dpi, quality));
  if (!images) return;
  const ext = type === 'jpeg' ? 'jpg' : type;
  const where = await platform.saveMany(images.map((b, i) => ({ name: `${base(d.name)}-${i + 1}.${ext}`, bytes: b })), `image/${type}`);
  if (where) showToast(`Saved ${images.length} images to ${where}`);
}

export async function extractImages() {
  const d = active.value;
  if (!d?.js) return;
  const files = await task('Extracting images…', async () => {
    const { layouts } = await import('../pdf/exporter');
    const { pages } = await layouts(await d.currentBytes(), d.js!);
    const doc = await loadPdf(await d.currentBytes());
    const { PageContent } = await import('../engine/pageContent');
    const out: { name: string; bytes: Uint8Array }[] = [];
    for (const p of pages) {
      const pc = new PageContent(doc, doc.getPage(p.index));
      for (const obj of pc.objects.filter((o) => o.kind !== 'form')) {
        const info = pc.imageStream(obj);
        if (info?.jpeg) { out.push({ name: `${base(d.name)} p${p.index + 1} image ${out.length + 1}.jpg`, bytes: info.stream.getContents() }); continue; }
        const canvas = await renderPage(d.js!, p.index, 3, { annotations: false });
        const vp = (await d.js!.getPage(p.index + 1)).getViewport({ scale: 3 });
        const [a, b] = [vp.convertToViewportPoint(obj.bounds.x, obj.bounds.y + obj.bounds.h), vp.convertToViewportPoint(obj.bounds.x + obj.bounds.w, obj.bounds.y)];
        const cut = document.createElement('canvas');
        cut.width = Math.max(1, Math.round(Math.abs(b[0] - a[0]))); cut.height = Math.max(1, Math.round(Math.abs(b[1] - a[1])));
        cut.getContext('2d')!.drawImage(canvas, Math.min(a[0], b[0]), Math.min(a[1], b[1]), cut.width, cut.height, 0, 0, cut.width, cut.height);
        out.push({ name: `${base(d.name)} p${p.index + 1} image ${out.length + 1}.png`, bytes: await canvasBytes(cut, 'image/png') });
      }
    }
    return out;
  });
  if (!files) return;
  if (!files.length) return showToast('No images in this document.');
  const where = await platform.saveMany(files, 'image/*');
  if (where) showToast(`Saved ${files.length} images to ${where}`);
}

export async function runOcr(pages: number[] | null, languages: string, skipText: boolean) {
  const d = active.value;
  if (!d?.js) return;
  await task('Recognizing text…', async (progress) => {
    const js = d.js!;
    let targets = pages ?? [...Array(js.numPages).keys()];
    if (skipText) {
      const keep: number[] = [];
      for (const i of targets) {
        const tc = await (await js.getPage(i + 1)).getTextContent();
        if (!tc.items.some((it) => 'str' in it && it.str.trim())) keep.push(i);
      }
      targets = keep;
    }
    if (!targets.length) { showToast('All selected pages already contain text.'); return; }
    const results = await recognize(js, targets, languages, progress);
    const found = [...results.values()].reduce((n, l) => n + l.length, 0);
    if (!found) { showToast('No text found.'); return; }
    await d.apply('Recognize Text', (doc) => addTextLayer(doc, results));
    showToast(`Recognized ${found} lines of text.`);
    platform.notify('OCR finished', d.name);
  });
}

export async function compressActive(preset: Preset) {
  const d = active.value;
  if (!d) return;
    const src = await d.currentBytes();
  const bytes = await task('Compressing…', (p) => compressBytes(src, preset, p));
  if (!bytes) return;
  const before = src.length;
  if (bytes.length >= before) return showToast('Already optimized: this level wouldn’t make it smaller.');
  await d.replaceUndoable('Compress', bytes);
  const mb = (n: number) => `${(n / 1_048_576).toFixed(2)} MB`;
  showToast(`${mb(before)} → ${mb(bytes.length)} (${Math.round((1 - bytes.length / before) * 100)}% smaller). Save to keep it.`);
}

export async function applyRedactions() {
  const d = active.value;
  if (!d?.js) return;
  if (!confirm('Apply redactions? The marked text and images are permanently removed when you save.')) return;
  await task('Redacting…', async () => {
    let fallback: number[] = [];
    await d.apply('Apply Redactions', async (doc) => { fallback = await editing.applyRedactions(doc); });
    if (fallback.length) {
      // Pages with drawings under a mark: flatten them to pictures so nothing remains underneath.
      const js = d.js!;
      const pictures = new Map<number, Uint8Array>();
      for (const i of fallback) {
        const page = await js.getPage(i + 1);
        const vp = page.getViewport({ scale: 200 / 72, rotation: 0 });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width; canvas.height = vp.height;
        await page.render({ canvasContext: canvas.getContext('2d')!, canvas, viewport: vp } as never).promise;
        pictures.set(i, await canvasBytes(canvas, 'image/jpeg', 0.9));
      }
      await d.apply('Flatten Redacted Pages', async (doc) => { for (const [i, jpg] of pictures) await editing.flattenPageToImage(doc, i, jpg); });
    }
    showToast('Redactions applied.');
  });
}

export async function markMatches(query: string, wholeWords: boolean) {
  const d = active.value;
  if (!d?.js || !query.trim()) return 0;
  const { pageTextItems } = await import('../engine/textItems');
  const hits: { page: number; rect: { x: number; y: number; w: number; h: number } }[] = [];
  const re = new RegExp((wholeWords ? '\\b' : '') + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (wholeWords ? '\\b' : ''), 'gi');
  for (let i = 0; i < d.js.numPages; i++) {
    for (const it of await pageTextItems(d.js, i + 1)) {
      for (const m of it.str.matchAll(re)) {
        const cw = it.w / it.str.length;
        const start = it.rtl ? it.str.length - (m.index! + m[0].length) : m.index!;
        hits.push({ page: i, rect: { x: it.x + start * cw - 0.5, y: it.y - it.h * 0.25, w: m[0].length * cw + 1, h: it.h * 1.25 } });
      }
    }
  }
  if (hits.length) await edit('Mark for Redaction', (doc) => { for (const h of hits) annots.addRedactionMark(doc, h.page, h.rect); });
  return hits.length;
}

export async function extractPagesTo(indices: number[]) {
  const d = active.value;
  if (!d) return;
  const doc = await d.library();
  await newDocument(`${base(d.name)} (pages).pdf`, await ops.extract(doc, indices));
}

export async function splitActive(mode: 'every' | 'ranges' | 'parts' | 'size', value: string, merge: boolean) {
  const d = active.value;
  if (!d) return;
  await task('Splitting…', async () => {
    const doc = await d.library();
    const groups = await ops.splitGroups(doc, mode, value);
    if (merge && mode === 'ranges') { await newDocument(`${base(d.name)} (selected).pdf`, await ops.extract(doc, groups.flat())); return; }
    const files = [];
    for (const [i, g] of groups.entries()) files.push({ name: `${base(d.name)} part ${i + 1}.pdf`, bytes: await ops.extract(doc, g) });
    const where = await platform.saveMany(files, 'application/pdf');
    if (where) showToast(`Saved ${files.length} files to ${where}`);
  });
}

export async function insertFromFiles(after: number) {
  const files = await platform.openFiles(`${pdfAccept},${imageAccept}`, true);
  if (files.length) await edit('Insert Pages', (doc) => ops.insertFiles(doc, after, files));
}

export async function addLinkAt(page: number, r: { x: number; y: number; w: number; h: number }) {
  const target = await prompt('Add link', '', 'Web address or page number', 'For example https://example.com, or 3 for page 3.');
  if (target) await edit('Add Link', (doc) => annots.addLink(doc, page, r, target));
}

export async function printActive() {
  const d = active.value;
  if (!d) return;
  if (platform.print) return platform.print(await d.saveBytes());
  const bytes = await d.saveBytes();
  if (platform.share) return platform.share(d.name, bytes, 'application/pdf');
}

export async function shareActive() {
  const d = active.value;
  if (!d || !platform.share) return;
  await platform.share(d.name, await d.saveBytes(), 'application/pdf');
}

export function closeOrganize() { organizing.value = false; }
export function goTo(i: number) { pageIndex.value = i; window.dispatchEvent(new CustomEvent('mkpdf-goto', { detail: i })); }
export { docs };
