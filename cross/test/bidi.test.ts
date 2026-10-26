// Edited Arabic text: numbers and Latin words inside a right-to-left line keep their own order.
(globalThis as Record<string, unknown>).__APP_VERSION__ = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

test('mixed-direction lines are drawn in visual order', async () => {
  const { drawBidi } = await import('../src/pdf/editing');
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const arabic = await doc.embedFont(fs.readFileSync('public/fonts/NotoNaskhArabic-Regular.ttf'), { subset: true });
  const latin = await doc.embedFont(fs.readFileSync('public/fonts/NotoSans-Regular.ttf'), { subset: true });
  const page = doc.addPage([400, 200]);
  drawBidi(page, 'مرحبا بالعالم 2026', 40, 120, 20, arabic, rgb(0, 0, 0), latin);
  drawBidi(page, 'Invoice رقم 15 total', 40, 60, 20, arabic, rgb(0, 0, 0), latin);
  const js = await pdfjs.getDocument({ data: await doc.save(), verbosity: 0 }).promise;
  const items = (await (await js.getPage(1)).getTextContent()).items as { str: string; transform: number[] }[];
  // Extracted Arabic from a subset font carries stray control characters and spaces; compare without them.
  const clean = (s: string) => s.replace(/[\u0000-\u001f\s]/g, '');
  const at = (s: string) => items.find((i) => clean(i.str).includes(clean(s)));
  assert.ok(at('2026'), 'the year keeps its digit order');
  assert.ok(!items.some((i) => i.str.includes('6202')));
  // Left-to-right line: Invoice, then the Arabic word, then "15 total".
  assert.ok(at('Invoice')!.transform[4] < at('رقم')!.transform[4]);
  assert.ok(at('رقم')!.transform[4] < at('15')!.transform[4]);
  // Right-to-left line: the number sits at the left end.
  assert.ok(at('2026')!.transform[4] < at('العالم')!.transform[4]);
});
