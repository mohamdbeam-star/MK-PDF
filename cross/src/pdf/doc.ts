// One open document: its bytes, undo/redo snapshots, and the pdf.js proxy used for viewing.
// Every edit is a pdf-lib transaction on the current bytes; undo restores the previous bytes.
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { signal } from '@preact/signals';
import { loadPdf } from '../engine/load';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const CMAPS = new URL('cmaps/', document.baseURI).href;
const FONTS = new URL('standard_fonts/', document.baseURI).href;

export async function openPdfjs(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ data: bytes.slice(), password, cMapUrl: CMAPS, cMapPacked: true, standardFontDataUrl: FONTS, enableXfa: true }).promise;
}

let nextId = 1;

export class DocModel {
  readonly id = nextId++;
  name: string;
  path?: string;                       // file path on Windows; absent for new or Android documents
  bytes: Uint8Array;
  protection?: { user?: string; owner: string; print: boolean; copy: boolean; modify: boolean; annotate: boolean };
  js?: PDFDocumentProxy;
  private undoStack: { bytes: Uint8Array; label: string }[] = [];
  private redoStack: { bytes: Uint8Array; label: string }[] = [];
  /** Bumped whenever the bytes change, so views re-render. */
  readonly version = signal(0);
  readonly dirty = signal(false);
  readonly busy = signal<string | null>(null);

  constructor(name: string, bytes: Uint8Array, path?: string) {
    this.name = name;
    this.bytes = bytes;
    this.path = path;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label; }
  get redoLabel() { return this.redoStack[this.redoStack.length - 1]?.label; }

  /** Opens the bytes in pdf.js. A protected file is decrypted once with `password`, and the same
   *  password is put back on when saving. */
  async load(password?: string) {
    if (password) {
      const { decrypt } = await import('./security');
      this.bytes = await decrypt(this.bytes, password);
      this.protection ??= { user: password, owner: password, print: true, copy: true, modify: true, annotate: true };
    }
    void this.js?.loadingTask.destroy();
    this.js = await openPdfjs(this.bytes);
  }

  /** Bytes including anything typed into form fields in the viewer. */
  async currentBytes(): Promise<Uint8Array> {
    const storage = this.js?.annotationStorage;
    if (this.js && storage && storage.size > 0 && (storage as unknown as { modified?: boolean }).modified !== false) {
      try { return await this.js.saveDocument(); } catch { /* fall through */ }
    }
    return this.bytes;
  }

  /** A pdf-lib document for the current state (decrypted when a password was given). */
  async library(): Promise<PDFDocument> {
    const doc = await loadPdf(await this.currentBytes(), { updateMetadata: false });
    doc.registerFontkit(fontkit);
    return doc;
  }

  /** Runs an edit as one undoable step. */
  async apply(label: string, edit: (doc: PDFDocument) => Promise<void> | void) {
    const before = await this.currentBytes();
    const doc = await this.library();
    await edit(doc);
    const after = await doc.save({ useObjectStreams: false });
    this.undoStack.push({ bytes: before, label });
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
    await this.replace(after);
  }

  /** Replaces the whole document (compression, OCR, repair…) as one undoable step. */
  async replaceUndoable(label: string, bytes: Uint8Array) {
    this.undoStack.push({ bytes: await this.currentBytes(), label });
    this.redoStack = [];
    await this.replace(bytes);
  }

  private async replace(bytes: Uint8Array) {
    this.bytes = bytes;
    await this.load();
    this.dirty.value = true;
    this.version.value++;
  }

  async undo() {
    const step = this.undoStack.pop();
    if (!step) return;
    this.redoStack.push({ bytes: await this.currentBytes(), label: step.label });
    await this.replace(step.bytes);
  }

  async redo() {
    const step = this.redoStack.pop();
    if (!step) return;
    this.undoStack.push({ bytes: await this.currentBytes(), label: step.label });
    await this.replace(step.bytes);
  }

  /** Bytes to write to disk, with protection applied when set. */
  async saveBytes(): Promise<Uint8Array> {
    const bytes = await this.currentBytes();
    return this.protection ? (await import('./security')).encrypt(bytes, this.protection) : bytes;
  }

  markSaved() { this.dirty.value = false; }
}
