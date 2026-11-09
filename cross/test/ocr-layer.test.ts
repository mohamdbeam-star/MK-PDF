// The invisible text layer written over recognised scans.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// The bundled fonts are fetched relative to the page; here they come from public/.
const pub = new URL('../public/', import.meta.url);
Object.assign(globalThis, {
  __APP_VERSION__: 'test',
  window: globalThis,
  document: { baseURI: pub.href },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
globalThis.fetch = (async (url: string | URL) => {
  const p = new URL(String(url));
  return fs.existsSync(p) ? new Response(fs.readFileSync(p)) : new Response(null, { status: 404 });
}) as typeof fetch;
const { addTextLayer } = await import('../src/pdf/ocr');

async function layerText(text: string) {
  const doc = await PDFDocument.create();
  doc.addPage([600, 400]);
  await addTextLayer(doc, new Map([[0, [{ text, x: 50, y: 300, w: 400, h: 20 }]]]));
  const js = await pdfjs.getDocument({ data: await doc.save(), verbosity: 0 }).promise;
  return ((await (await js.getPage(1)).getTextContent()).items as { str: string }[]).map((i) => i.str).join(' ');
}

test('a recognised line mixing Arabic and Latin keeps both scripts', async () => {
  const t = (await layerText('Total المجموع 920')).normalize('NFKC');
  assert.ok(!/[\u0000-\u0008]/.test(t), `control characters in ${JSON.stringify(t)}`);
  assert.match(t, /Total/);
  assert.match(t, /920/);
  assert.match(t.replace(/\s/g, ''), /المجموع/);
});

test('a Latin line is unchanged', async () => {
  assert.match(await layerText('INVOICE NUMBER 4471'), /INVOICE NUMBER 4471/);
});
