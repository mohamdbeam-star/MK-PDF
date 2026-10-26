// Password protection, unlocking, repair and lossless optimisation through qpdf (WebAssembly).
import qpdfInit, { type QpdfInstance } from '@neslinesli93/qpdf-wasm';
import wasmUrl from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url';

let instance: Promise<QpdfInstance> | null = null;
const qpdf = () => (instance ??= qpdfInit({ locateFile: () => wasmUrl }));

type FS = QpdfInstance['FS'] & { writeFile(p: string, d: Uint8Array): void; unlink(p: string): void };

async function run(args: string[], input: Uint8Array): Promise<Uint8Array> {
  const q = await qpdf();
  const fs = q.FS as FS;
  fs.writeFile('/in.pdf', input);
  const rc = q.callMain([...args.map((a) => (a === '$IN' ? '/in.pdf' : a === '$OUT' ? '/out.pdf' : a))]);
  // qpdf exits 3 for "succeeded with warnings".
  if (rc !== 0 && rc !== 3) throw new Error(`qpdf failed (${rc})`);
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

/** Rewrites the file structure; recovers many damaged PDFs. */
export function repair(bytes: Uint8Array): Promise<Uint8Array> {
  return run(['$IN', '--object-streams=preserve', '$OUT'], bytes);
}

/** Lossless size reduction: object streams and maximum Flate compression. */
export function optimize(bytes: Uint8Array): Promise<Uint8Array> {
  return run(['$IN', '--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9', '$OUT'], bytes);
}
