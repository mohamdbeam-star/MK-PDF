// Password protection, unlocking, repair and lossless optimisation through qpdf (WebAssembly).
import qpdfInit, { type QpdfInstance } from '@neslinesli93/qpdf-wasm';
import wasmUrl from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url';

let instance: Promise<QpdfInstance> | null = null;
let messages: string[] = [];
let capturing = false;
// The qpdf build writes its warnings with its own copy of console.error, taken when it loads; that copy is
// pointed here so a run's messages become its error text instead of console noise.
const qpdf = () => (instance ??= (() => {
  const original = console.error;
  console.error = (...a: unknown[]) => (capturing ? messages.push(a.join(' ')) : original(...a));
  const ready = qpdfInit({ locateFile: () => wasmUrl });
  console.error = original;
  return ready;
})());

type FS = QpdfInstance['FS'] & { writeFile(p: string, d: Uint8Array): void; unlink(p: string): void };

async function run(args: string[], input: Uint8Array): Promise<Uint8Array> {
  const q = await qpdf();
  const fs = q.FS as FS;
  fs.writeFile('/in.pdf', input);
  messages = [];
  capturing = true;
  let rc: number;
  try { rc = q.callMain([...args.map((a) => (a === '$IN' ? '/in.pdf' : a === '$OUT' ? '/out.pdf' : a))]); } finally { capturing = false; }
  // qpdf exits 3 for "succeeded with warnings".
  if (rc !== 0 && rc !== 3) throw new Error(messages.at(-1)?.replace(/^.*?\/in\.pdf:?\s*/, '') || `qpdf failed (${rc})`);
  const out = fs.readFile('/out.pdf');
  try { fs.unlink('/in.pdf'); fs.unlink('/out.pdf'); } catch { /* ignore */ }
  return out;
}

export interface Protection { user?: string; owner: string; print: boolean; copy: boolean; modify: boolean; annotate: boolean }

export function encrypt(bytes: Uint8Array, p: Protection): Promise<Uint8Array> {
  const args = ['$IN', '--encrypt', p.user ?? '', p.owner || crypto.randomUUID(), '256',
    `--print=${p.print ? 'full' : 'none'}`, `--extract=${p.copy ? 'y' : 'n'}`, `--modify=${p.modify ? 'all' : 'none'}`,
    `--annotate=${p.annotate ? 'y' : 'n'}`, '--', '$OUT'];
  return run(args, bytes);
}

export function decrypt(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  return run([`--password=${password}`, '--decrypt', '$IN', '$OUT'], bytes);
}

/** Rewrites the file structure; recovers many damaged PDFs. When qpdf can't find its way through the file
 *  (cross-reference table cut off or pointing at the wrong places), the objects are read in file order instead
 *  and written out with a fresh table. */
export async function repair(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    return await run(['$IN', '--object-streams=preserve', '$OUT'], bytes);
  } catch (e) {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false }).catch(() => null);
    if (!doc?.getPageCount()) throw new Error('This file is too damaged to recover.', { cause: e });
    return doc.save({ useObjectStreams: false });
  }
}

/** Lossless size reduction: object streams and maximum Flate compression. */
export function optimize(bytes: Uint8Array): Promise<Uint8Array> {
  return run(['$IN', '--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9', '$OUT'], bytes);
}
