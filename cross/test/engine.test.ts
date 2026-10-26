import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parse } from '../src/engine/contentStream';
import { PageContent, rect } from '../src/engine/pageContent';

const SAMPLES = process.env.MKPDF_SAMPLES ?? '';

async function textItems(bytes: Uint8Array, page = 1) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const tc = await (await doc.getPage(page)).getTextContent();
  return tc.items as { str: string; transform: number[]; width: number; height: number }[];
}
const joined = (items: { str: string }[]) => items.map((i) => i.str).join(' ').replace(/\s+/g, ' ');

/** Page-space box of a word found in pdf.js text items (proportional within its item). */
export function wordRect(items: { str: string; transform: number[]; width: number; height: number }[], word: string) {
  for (const it of items) {
    const i = it.str.indexOf(word);
    if (i < 0) continue;
    const cw = it.width / Math.max(it.str.length, 1);
    return rect(it.transform[4] + i * cw, it.transform[5] - it.height * 0.2, word.length * cw, it.height * 1.1);
  }
  return null;
}

async function handWritten(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Invoice number 1234 is secret data', { x: 72, y: 700, size: 14, font: f });
  page.drawText('Courier text stays here', { x: 72, y: 600, size: 12, font: f });
  return doc.save();
}

test('parses operators, strings and inline images', () => {
  const ops = parse(new TextEncoder().encode('BT /F1 12 Tf (a\\(b\\)c) Tj [(x) -20 <0041>] TJ ET BI /W 1 /H 1 /CS /G /BPC 8 ID \x7f EI Q'));
  assert.deepEqual(ops.map((o) => o.op), ['BT', 'Tf', 'Tj', 'TJ', 'ET', 'BI', 'Q']);
  assert.deepEqual(Array.from((ops[2].operands[0] as { v: Uint8Array }).v), Array.from(new TextEncoder().encode('a(b)c')));
});

const files: [string, () => Promise<Uint8Array>, string, string][] = [['pdf-lib', handWritten, 'secret', 'data']];
if (SAMPLES) {
  files.push(['Quartz sample', async () => fs.readFileSync(`${SAMPLES}/work/Orig.pdf`), 'enquiry', 'pleased']);
  files.push(['real Word PDF', async () => fs.readFileSync(`${SAMPLES}/real/FTA decision No 13 for ITC conditions.pdf`), 'Chairman', 'Board']);
}

for (const [label, make, target, keep] of files) {
  test(`${label}: round trip and glyph-exact removal`, async () => {
    const bytes = await make();
    const before = await textItems(bytes);
    // Round trip with no edits keeps the text.
    const doc = await PDFDocument.load(bytes);
    const pc = new PageContent(doc, doc.getPage(0));
    assert.ok(pc.glyphs.length > 10, 'finds glyphs');
    pc.commit();
    assert.equal(joined(await textItems(await doc.save())), joined(before));
    // Remove the text item holding the target word; every other glyph must stay exactly where it was.
    const item = before.find((it) => it.str.includes(target))!;
    const r = rect(item.transform[4] - 0.5, item.transform[5] - item.height * 0.3, item.width + 1, item.height * 1.2);
    const doc2 = await PDFDocument.load(bytes);
    const pc2 = new PageContent(doc2, doc2.getPage(0));
    const inR = (g: { rect: { x: number; y: number; w: number; h: number } }) => {
      const cx = g.rect.x + g.rect.w / 2, cy = g.rect.y + g.rect.h / 2;
      return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
    };
    const keptBefore = pc2.glyphs.filter((g) => !inR(g)).map((g) => [g.origin.x, g.origin.y]);
    const removed = pc2.removeText([r]);
    assert.ok(removed >= target.length, `removed ${removed} glyphs`);
    pc2.commit();
    const saved = await doc2.save();
    const reloaded = await PDFDocument.load(saved);
    const keptAfter = new PageContent(reloaded, reloaded.getPage(0)).glyphs.map((g) => [g.origin.x, g.origin.y]);
    assert.equal(keptAfter.length, keptBefore.length, 'same number of remaining glyphs');
    const worst = Math.max(...keptAfter.map((p, i) => Math.hypot(p[0] - keptBefore[i][0], p[1] - keptBefore[i][1])));
    assert.ok(worst < 0.01, `remaining glyphs unmoved (worst ${worst.toFixed(4)})`);
    const after = joined(await textItems(saved));
    assert.ok(!after.includes(item.str.trim()), `"${item.str.trim()}" gone`);
    assert.ok(joined(before).replace(item.str, '').split(' ').filter((w) => w.length > 3).slice(0, 20).every((w) => after.includes(w)), 'other text kept');
  });
}

if (SAMPLES) {
  test('images: locate, move, delete', async () => {
    const doc = await PDFDocument.load(fs.readFileSync(`${SAMPLES}/work/Orig.pdf`));
    const pc = new PageContent(doc, doc.getPage(0));
    const img = pc.objects.find((o) => o.kind === 'image')!;
    assert.ok(Math.abs(img.bounds.x - 440) < 1 && Math.abs(img.bounds.w - 120) < 1);
    pc.transformObject(img, rect(100, 100, 200, 80));
    const moved = pc.objects.find((o) => o.kind === 'image')!;
    assert.ok(Math.abs(moved.bounds.x - 100) < 0.01 && Math.abs(moved.bounds.w - 200) < 0.01);
    pc.removeObject(moved);
    assert.equal(pc.objects.filter((o) => o.kind === 'image').length, 0);
  });
}
