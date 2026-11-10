// User-level actions: each one gathers input, runs a PDF operation as an undoable step and reports back.
import { PDFDocument } from 'pdf-lib';
import { platform } from './platform';
import {
  active, busy, choose, dialog, docs, editObject, newDocument, tool, openDocument, organizing, pageIndex, prompt, readMode, selectedAnnot, showSaved, showToast, task,
} from './store';
import * as ops from '../pdf/ops';
import * as annots from '../pdf/annots';
import * as editing from '../pdf/editing';
import { compress as compressBytes, Preset } from '../pdf/compress';
import { repair as repairBytes } from '../pdf/security';
import { DOC_FORMATS, DocFormat, MIME, exportDocument, exportImages } from '../pdf/exporter';
import { addTextLayer, applyCorrections, recognize, type Suspect } from '../pdf/ocr';
import { renderPage, canvasBytes } from '../pdf/render';
import { loadPdf } from '../engine/load';
import * as extras from '../pdf/extras';

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

export async function exportAs(format: DocFormat, ocr: boolean, opts: { flow?: boolean; images?: boolean; comments?: boolean } = {}) {
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
    return exportDocument(bytes, js, format, base(d.name), opts);
  });
  if (!result) return;
  const saved = await platform.saveFile(`${base(d.name)}.${format}`, result, MIME[format]);
  if (saved) { showSaved(`Exported to ${saved.label}`); platform.notify('Export finished', saved.label); }
}

/** Exports the part of a page inside a dragged box, as Word, Excel or CSV. */
export async function exportAreaAs(page: number, r: { x: number; y: number; w: number; h: number }) {
  const d = active.value;
  if (!d?.js) return;
  const pick = await choose('Export this area', ['Word (.docx)', 'Excel (.xlsx)', 'CSV (.csv)']);
  tool.value = 'select';
  if (pick === null) return;
  const format = (['docx', 'xlsx', 'csv'] as const)[pick];
  const { exportArea } = await import('../pdf/exporter');
  const bytes = await task('Exporting…', async () => exportArea(await d.currentBytes(), d.js!, page, r, format));
  if (bytes === undefined) return;
  if (!bytes) return showToast('No text or tables in that area.');
  const saved = await platform.saveFile(`${base(d.name)} (part).${format}`, bytes, MIME[format]);
  if (saved) showSaved(`Exported to ${saved.label}`);
}

export async function exportPageImages(type: 'png' | 'jpeg' | 'webp', dpi: number, quality: number) {
  const d = active.value;
  if (!d?.js) return;
  const images = await task('Exporting images…', () => exportImages(d.js!, type, dpi, quality));
  if (!images) return;
  const ext = type === 'jpeg' ? 'jpg' : type;
  const where = await platform.saveMany(images.map((b, i) => ({ name: `${base(d.name)}-${i + 1}.${ext}`, bytes: b })), `image/${type}`);
  if (where) showSaved(`Saved ${images.length} ${images.length === 1 ? 'image' : 'images'} to ${where}`);
}

/** Saves every picture in the document; pictures under `minPixels` on their longer side (icons, bullets, specks) are skipped. */
export async function extractImages(minPixels = 0) {
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
        if (minPixels && Math.max(info?.width || obj.bounds.w * 3, info?.height || obj.bounds.h * 3) < minPixels) continue;
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
  if (!files.length) return showToast(minPixels ? `No images of ${minPixels} pixels or more.` : 'No images in this document.');
  const where = await platform.saveMany(files, 'image/*');
  if (where) showSaved(`Saved ${files.length} ${files.length === 1 ? 'image' : 'images'} to ${where}`);
}

export async function runOcr(pages: number[] | null, languages: string, skipText: boolean, clean = true) {
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
    let straightened = 0;
    if (clean) {
      // Straighten and whiten scans first: recognition reads them better, and the text layer lines up with the
      // cleaned page.
      const { cleanScans, replacePageImage, scannedPages } = await import('../pdf/enhance');
      const scans = await scannedPages(await d.library(), js, targets);
      const changed = await cleanScans(js, scans, (p) => progress(p * 0.3));
      if (changed.size) {
        await d.apply('Clean Up Scans', async (doc) => { for (const [i, c] of changed) await replacePageImage(doc, i, c.jpeg); });
        straightened = [...changed.values()].filter((c) => Math.abs(c.e.angle) >= 0.3).length;
      }
    }
    const suspects: Suspect[] = [];
    const results = await recognize(d.js!, targets, languages, (p) => progress(clean ? 0.3 + p * 0.7 : p), suspects);
    const found = [...results.values()].reduce((n, l) => n + l.length, 0);
    if (!found) { showToast('No text found.'); return; }
    if (suspects.length) {
      busy.value = null; // the review sheet replaces the progress overlay
      applyCorrections(results, suspects, await reviewWords(suspects));
      busy.value = { label: 'Recognizing text…' };
    }
    await d.apply('Recognize Text', (doc) => addTextLayer(doc, results));
    const notes = [straightened && `straightened ${straightened} ${straightened === 1 ? 'page' : 'pages'}`,
      suspects.length && `reviewed ${suspects.length} uncertain ${suspects.length === 1 ? 'word' : 'words'}`].filter(Boolean);
    showToast(`Recognized ${found} ${found === 1 ? 'line' : 'lines'} of text${notes.length ? `; ${notes.join(', ')}` : ''}.`);
    platform.notify('OCR finished', d.name);
  });
}

/** Steps through uncertain words; resolves with each word as accepted (unchanged ones included). */
function reviewWords(suspects: Suspect[]): Promise<string[]> {
  return new Promise((resolve) => { dialog.value = { kind: 'ocrReview', props: { suspects, resolve } }; });
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
  const re = searchPattern(query, { wholeWords });
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

/** The search pattern for Find, Mark and Replace. */
export function searchPattern(query: string, o: { matchCase?: boolean; wholeWords?: boolean } = {}) {
  const body = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(o.wholeWords ? `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])` : body, `gu${o.matchCase ? '' : 'i'}`);
}

/**
 * Replaces text everywhere in the document, as one undoable step. Each paragraph with a match is rewritten the way
 * the editor rewrites it: same font (the document's own when it has the letters), size, colour and place; on
 * recognised scans the old letters are covered in the paper colour. Returns how many matches were replaced.
 */
export async function replaceText(query: string, replacement: string, o: { matchCase?: boolean; wholeWords?: boolean } = {}) {
  const d = active.value;
  if (!d?.js || !query) return 0;
  const js = d.js;
  const { pageTextItems } = await import('../engine/textItems');
  const { layoutPage, editableBlocks, paragraphText } = await import('../engine/layout');
  const { PageContent } = await import('../engine/pageContent');
  const { coverRects, isScanned, sampleColors } = await import('../pdf/scan');
  const re = searchPattern(query, o);
  const pages: number[] = [];
  for (let i = 0; i < js.numPages; i++) if ((await pageTextItems(js, i + 1)).some((it) => it.str.search(re) >= 0)) pages.push(i);
  if (!pages.length) return 0;
  let count = 0;
  await edit('Replace', async (doc) => {
    for (const i of pages) {
      const layout = layoutPage(doc, i, await pageTextItems(js, i + 1), new PageContent(doc, doc.getPage(i)));
      for (const b of editableBlocks(layout)) {
        const text = paragraphText(b);
        const n = [...text.matchAll(re)].length;
        if (!n) continue;
        count += n;
        let style = editing.styleOf(b);
        let cover: { rects: { x: number; y: number; w: number; h: number }[]; paper: [number, number, number] } | undefined;
        if (isScanned(b)) {
          const { paper, ink } = await sampleColors(js, i, b.rect);
          cover = { rects: coverRects(b), paper };
          style = { ...style, color: ink };
        }
        await editing.commitText(doc, i, b, text.replace(re, () => replacement), style, { x: b.lines[0].rect.x, y: b.lines[0].baseline },
          b.lines.length > 1 ? b.rect.w + 2 : undefined, b.rect.w, cover);
      }
    }
  });
  return count;
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
    if (where) showSaved(`Saved ${files.length} files to ${where}`);
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

// MARK: features matching the Mac app

const savePdf = async (name: string, bytes: Uint8Array) => {
  const r = await platform.saveFile(name, bytes, 'application/pdf');
  if (r) showSaved(`Saved to ${r.label}`);
};

/** A copy of the document as flattened (print-ready), grayscale or PDF/X-3 output. */
export async function savePdfVariant(kind: 'flattened' | 'grayscale' | 'pdfx') {
  const d = active.value;
  if (!d) return;
  const label = { flattened: 'flattened', grayscale: 'grayscale', pdfx: 'PDF-X' }[kind];
  const bytes = await task(`Creating ${label} PDF…`, async () => {
    const doc = await loadPdf(await d.saveBytes());
    if (kind === 'flattened') { ops.flattenForms(doc); extras.flattenAnnotations(doc, 'all'); }
    if (kind === 'grayscale') await extras.grayscale(doc);
    if (kind === 'pdfx') extras.pdfx3(doc);
    return doc.save();
  });
  if (bytes) await savePdf(`${base(d.name)} (${label}).pdf`, bytes);
}

export async function exportCommentSummary() {
  const d = active.value;
  if (!d) return;
  const html = extras.commentSummary(await d.library(), d.name);
  const r = await platform.saveFile(`${base(d.name)} comments.html`, new TextEncoder().encode(html), 'text/html');
  if (r) showSaved(`Saved to ${r.label}`);
}

export const flattenComments = () => edit('Flatten Comments', (doc) => extras.flattenAnnotations(doc, 'comments'));

export async function replaceCurrentPage() {
  const d = active.value;
  if (!d) return;
  const [f] = await platform.openFiles(pdfAccept, false);
  if (!f) return;
  const src = await loadPdf(f.bytes);
  let from = 0;
  if (src.getPageCount() > 1) {
    const r = await prompt('Replace page', '1', `Page of “${f.name}” to use (1–${src.getPageCount()})`);
    if (!r) return;
    from = Math.max(0, Math.min(src.getPageCount() - 1, (Number(r) || 1) - 1));
  }
  const i = pageIndex.value;
  await edit('Replace Page', (doc) => extras.replacePage(doc, i, f.bytes, from));
}

export async function splitByBookmarks() {
  const d = active.value;
  if (!d) return;
  await task('Splitting…', async () => {
    const doc = await d.library();
    const groups = extras.bookmarkGroups(doc);
    if (!groups.length) { showToast('This document has no bookmarks to split at.'); return; }
    const safe = (t: string) => t.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'part';
    const files = [];
    for (const [i, g] of groups.entries()) files.push({ name: `${base(d.name)} ${i + 1} ${safe(g.title)}.pdf`, bytes: await ops.extract(doc, g.pages) });
    const where = await platform.saveMany(files, 'application/pdf');
    if (where) showSaved(`Saved ${files.length} files to ${where}`);
  });
}

export async function addBookmarkHere() {
  const i = pageIndex.value;
  const title = await prompt('Add bookmark', `Page ${i + 1}`, 'Title');
  if (title) await edit('Add Bookmark', (doc) => extras.addBookmark(doc, title, i));
}

export async function renameBookmarkAt(index: number, current: string) {
  const title = await prompt('Rename bookmark', current, 'Title');
  if (title) await edit('Rename Bookmark', (doc) => { const b = extras.listBookmarks(doc)[index]; if (b) extras.renameBookmark(doc, b.ref, title); });
}

export const deleteBookmarkAt = (index: number) =>
  edit('Delete Bookmark', (doc) => { const b = extras.listBookmarks(doc)[index]; if (b) extras.deleteBookmark(doc, b.ref); });

export async function renameFieldNamed(name: string) {
  const to = await prompt('Rename field', name, 'Field name');
  if (to && to !== name) await edit('Rename Field', (doc) => extras.renameField(doc, name, to));
}

export const deleteFieldNamed = (name: string) => edit('Delete Field', (doc) => extras.deleteField(doc, name));

/** Size of the document now and after compressing at `preset` (nothing is changed). */
export async function estimateCompression(preset: Preset) {
  const d = active.value;
  if (!d) return null;
  const src = await d.currentBytes();
  const out = await task('Estimating size…', (p) => compressBytes(src, preset, p));
  return out ? { before: src.length, after: Math.min(out.length, src.length) } : null;
}

/** "Cover and retype": the text under a box is covered in white and retyped as new text in the same place. */
export async function coverAndRetype(page: number, r: { x: number; y: number; w: number; h: number }) {
  const d = active.value;
  if (!d?.js) return;
  const { pageTextItems } = await import('../engine/textItems');
  const items = (await pageTextItems(d.js, page + 1)).filter((it) => it.x < r.x + r.w && it.x + it.w > r.x && it.y >= r.y - it.h * 0.3 && it.y <= r.y + r.h);
  const lines = new Map<number, typeof items>();
  for (const it of items) { const k = Math.round(it.y); lines.set(k, [...(lines.get(k) ?? []), it]); }
  const current = [...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, l]) => l.sort((a, b) => a.x - b.x).map((i) => i.str).join('')).join('\n');
  const text = await prompt('Cover and retype', current, 'New text', 'The text under the box is covered and this text is written in its place.');
  if (text === null) return;
  const size = Math.max(6, Math.min(48, (items[0]?.h ?? r.h * 0.7) * 0.95));
  await edit('Cover and Retype', async (doc) => {
    annots.addWhiteout(doc, page, r);
    if (text.trim()) await annots.addFreeText(doc, page, r.x - 3, r.y + r.h / 2, text, size, [0, 0, 0]);
  });
}

/** Saves an image on the page as a PNG (as it appears, at 3× resolution). */
export async function saveObjectAsPng(page: number, bounds: { x: number; y: number; w: number; h: number }) {
  const d = active.value;
  if (!d?.js) return;
  const bytes = await task('Saving image…', async () => {
    const canvas = await renderPage(d.js!, page, 3, { annotations: false });
    const vp = (await d.js!.getPage(page + 1)).getViewport({ scale: 3 });
    const [a, b] = [vp.convertToViewportPoint(bounds.x, bounds.y + bounds.h), vp.convertToViewportPoint(bounds.x + bounds.w, bounds.y)];
    const cut = document.createElement('canvas');
    cut.width = Math.max(1, Math.round(Math.abs(b[0] - a[0]))); cut.height = Math.max(1, Math.round(Math.abs(b[1] - a[1])));
    cut.getContext('2d')!.drawImage(canvas, Math.min(a[0], b[0]), Math.min(a[1], b[1]), cut.width, cut.height, 0, 0, cut.width, cut.height);
    return canvasBytes(cut, 'image/png');
  });
  if (bytes) { const r = await platform.saveFile(`${base(d.name)} image.png`, bytes, 'image/png'); if (r) showSaved(`Saved to ${r.label}`); }
}

// MARK: read aloud

let speaking = false;
/** Reads the document aloud from the current page (again to stop). */
export async function readAloud() {
  const d = active.value;
  if (!d?.js) return;
  if (speaking) { platform.stopSpeaking(); speaking = false; showToast('Stopped reading.'); return; }
  const { pageTextItems } = await import('../engine/textItems');
  let text = '';
  for (let i = pageIndex.value; i < d.js.numPages && text.length < 60_000; i++) text += (await pageTextItems(d.js, i + 1)).map((it) => it.str).join(' ') + '\n';
  if (!text.trim()) return showToast('No text to read on these pages.');
  speaking = true;
  showToast('Reading aloud. Choose Read Aloud again to stop.');
  await platform.speak(text, () => { speaking = false; });
}

// MARK: batch

export type BatchOp = 'compress' | 'ocr' | 'pageNumbers' | 'watermark' | 'password' | 'rotate' | 'flatten' | 'metadata' | 'jpg' | 'docx' | 'txt';
export const BATCH_OPS: { id: BatchOp; title: string; input?: string }[] = [
  { id: 'compress', title: 'Compress' }, { id: 'ocr', title: 'Recognize text (OCR)' }, { id: 'pageNumbers', title: 'Add page numbers' },
  { id: 'watermark', title: 'Add a text watermark', input: 'Watermark text' }, { id: 'password', title: 'Add a password', input: 'Password' },
  { id: 'rotate', title: 'Rotate all pages right' }, { id: 'flatten', title: 'Flatten forms and comments' }, { id: 'metadata', title: 'Remove metadata' },
  { id: 'jpg', title: 'Convert to JPG images' }, { id: 'docx', title: 'Convert to Word' }, { id: 'txt', title: 'Convert to text' },
];

/** Runs one operation on many PDFs and saves the results together. */
export async function runBatch(files: { name: string; bytes: Uint8Array }[], which: BatchOp, value: string) {
  const out = await task('Processing files…', async (progress) => {
    const results: { name: string; bytes: Uint8Array }[] = [];
    const { openPdfjs } = await import('../pdf/doc');
    for (const [k, f] of files.entries()) {
      const stem = base(f.name);
      try {
        if (which === 'compress') results.push({ name: `${stem} (compressed).pdf`, bytes: await compressBytes(f.bytes, 'balanced', () => {}) });
        else if (which === 'jpg' || which === 'docx' || which === 'txt' || which === 'ocr') {
          const js = await openPdfjs(f.bytes);
          if (which === 'jpg') (await exportImages(js, 'jpeg', 150, 0.9)).forEach((b, i) => results.push({ name: `${stem}-${i + 1}.jpg`, bytes: b }));
          else if (which === 'ocr') {
            const pages = [...Array(js.numPages).keys()];
            const recognised = await recognize(js, pages, 'eng+ara', () => {});
            const doc = await loadPdf(f.bytes);
            await addTextLayer(doc, recognised);
            results.push({ name: `${stem} (OCR).pdf`, bytes: await doc.save() });
          } else results.push({ name: `${stem}.${which}`, bytes: await exportDocument(f.bytes, js, which, stem) });
          void js.loadingTask.destroy();
        } else {
          const doc = await loadPdf(f.bytes);
          if (which === 'pageNumbers') await ops.headerFooter(doc, ['', '', '', '', 'Page {page} of {pages}', ''], { size: 10, margin: 28, file: stem });
          if (which === 'watermark') await ops.watermark(doc, doc.getPageIndices(), { text: value || 'CONFIDENTIAL', size: 60, opacity: 0.2, angle: 45, color: [0.6, 0.6, 0.6] });
          if (which === 'rotate') ops.rotatePages(doc, doc.getPageIndices(), 90);
          if (which === 'flatten') { ops.flattenForms(doc); extras.flattenAnnotations(doc, 'all'); }
          if (which === 'metadata') ops.removeMetadata(doc);
          let bytes = await doc.save();
          if (which === 'password') bytes = await (await import('../pdf/security')).encrypt(bytes, { user: value, owner: value, print: true, copy: true, modify: true, annotate: true });
          results.push({ name: `${stem} (${BATCH_OPS.find((o) => o.id === which)!.title.toLowerCase()}).pdf`, bytes });
        }
      } catch (e) {
        showToast(`${f.name}: ${(e as Error).message}`);
      }
      progress((k + 1) / files.length);
    }
    return results;
  });
  if (!out?.length) return;
  const where = await platform.saveMany(out, 'application/octet-stream');
  if (where) { showSaved(`Saved ${out.length} files to ${where}`); platform.notify('Batch finished', `${out.length} files`); }
}

/** Read mode: only the pages, full screen; Escape or the button leaves it. */
export function enterReadMode() {
  readMode.value = true;
  void document.documentElement.requestFullscreen?.().catch(() => {});
}
export function exitReadMode() {
  readMode.value = false;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
}

// MARK: translate (iPhone)

export const LANGUAGES: [string, string][] = [['ar', 'Arabic'], ['en', 'English'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['ru', 'Russian'], ['zh-Hans', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['tr', 'Turkish'], ['hi', 'Hindi'], ['nl', 'Dutch'],
  ['pl', 'Polish'], ['uk', 'Ukrainian']];

/** Translates the document on the device, paragraph by paragraph, and shows the result. */
export async function translateDocument(target: string) {
  const d = active.value;
  if (!d?.js || !platform.translate) return;
  const result = await task('Translating…', async () => {
    const { pageTextItems } = await import('../engine/textItems');
    const pages: string[] = [];
    for (let i = 0; i < d.js!.numPages; i++) {
      const items = await pageTextItems(d.js!, i + 1);
      const lines = new Map<number, typeof items>();
      for (const it of items) { const k = Math.round(it.y / 2); lines.set(k, [...(lines.get(k) ?? []), it]); }
      pages.push([...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, l]) => l.sort((a, b) => a.x - b.x).map((x) => x.str).join(' ')).join('\n'));
    }
    const paragraphs = pages.flatMap((p, i) => [...(i ? ['\f'] : []), ...p.split('\n')]);
    const out = await platform.translate!(paragraphs.map((p) => (p === '\f' ? '' : p)), target);
    return out.map((t, i) => (paragraphs[i] === '\f' ? '\n— — —\n' : t)).join('\n');
  });
  if (result) (await import('./store')).dialog.value = { kind: 'translation', props: { text: result, name: base(d.name) } };
}

