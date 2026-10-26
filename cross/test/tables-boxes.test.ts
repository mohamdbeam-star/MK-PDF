// Web-style pages (as printed by browsers): tables drawn with row lines only, and text in shaded rounded boxes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { layoutPage, lineText, type LayoutTable } from '../src/engine/layout';
import { pageTextItems } from '../src/engine/textItems';

async function layoutOf(build: (doc: PDFDocument) => Promise<void>) {
  const doc = await PDFDocument.create();
  await build(doc);
  const bytes = await doc.save();
  const lib = await PDFDocument.load(bytes);
  const js = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  return layoutPage(lib, 0, await pageTextItems(js as never, 1));
}

test('a table drawn with row lines only (no vertical lines) is one table with its columns', async () => {
  const cols = [50, 160, 290, 400, 545];
  const layout = await layoutOf(async (doc) => {
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // Header row: one dark cell per column.
    for (let c = 0; c < 4; c++) page.drawRectangle({ x: cols[c], y: 600, width: cols[c + 1] - cols[c], height: 30, color: rgb(0.06, 0.09, 0.16) });
    const rows = [['Timeframe', 'Buy', 'Lease', 'Saving'], ['6 Months', '4,200', '2,100', 'Lease'], ['12 Months', '5,100', '4,200', 'Lease'], ['24 Months', '6,900', '8,400', 'Buy']];
    rows.forEach((row, r) => {
      const top = 630 - r * 30;
      row.forEach((t, c) => page.drawText(t, { x: cols[c] + 6, y: top - 20, size: 10, font, color: r ? rgb(0, 0, 0) : rgb(1, 1, 1) }));
      // The line under each row is drawn cell by cell, as browsers do.
      if (r) for (let c = 0; c < 4; c++) page.drawLine({ start: { x: cols[c], y: top - 30 }, end: { x: cols[c + 1], y: top - 30 }, thickness: 0.6, color: rgb(0.85, 0.85, 0.85) });
    });
  });
  const tables = layout.items.filter((i): i is LayoutTable => i.kind === 'table');
  assert.equal(tables.length, 1, 'one table');
  const t = tables[0];
  assert.equal(t.colEdges.length - 1, 4, 'four columns');
  assert.equal(t.rowEdges.length - 1, 4, 'four rows');
  const cell = (r: number, c: number) => t.cells.find((x) => x.row === r && x.col === c)!.lines.map(lineText).join(' ');
  assert.equal(cell(0, 0), 'Timeframe');
  assert.equal(cell(3, 2), '8,400');
  assert.ok(t.cells.filter((c) => c.row === 0).every((c) => c.fill), 'header cells keep their shading');
  assert.ok(t.cells.every((c) => !c.borders.left && !c.borders.right), 'no vertical borders invented');
});

test('text in a shaded rounded box becomes a box with its fill and accent stripe', async () => {
  const layout = await layoutOf(async (doc) => {
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // An accent stripe, then a rounded box drawn over it (leaving 3pt of stripe on the left).
    page.drawRectangle({ x: 50, y: 600, width: 3, height: 80, color: rgb(0.85, 0.47, 0.02) });
    page.drawSvgPath('M 8 0 L 484 0 C 489 0 492 3 492 8 L 492 72 C 492 77 489 80 484 80 L 8 80 C 3 80 0 77 0 72 L 0 8 C 0 3 3 0 8 0 Z',
      { x: 53, y: 680, color: rgb(1, 0.98, 0.92) });
    page.drawText('Notice: the promotion ends soon.', { x: 70, y: 640, size: 11, font, color: rgb(0.7, 0.33, 0.04) });
  });
  assert.equal(layout.boxes.length, 1, 'one box');
  const box = layout.boxes[0];
  assert.ok(box.fill && box.fill[0] > 0.99 && box.fill[1] > 0.97, 'the box keeps its pale fill');
  assert.ok(box.borders.left && box.borders.left.color[0] > 0.8 && box.borders.left.color[2] < 0.1, 'the orange stripe is its left border');
  assert.ok(!box.figure, 'text, not a chart');
});
