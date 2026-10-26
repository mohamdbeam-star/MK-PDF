// Two-column pages (contracts, terms and conditions): each column is read top to bottom, not line by line across.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { layoutPage, lineText, type LayoutParagraph } from '../src/engine/layout';
import { pageTextItems } from '../src/engine/textItems';

test('a two-column page becomes one column band, with headings kept beside their own column', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const title = 'TERMS AND CONDITIONS';
  page.drawText(title, { x: (595 - bold.widthOfTextAtSize(title, 11)) / 2, y: 760, size: 11, font: bold });
  const words = 'the company shall pay the fees in the manner and amounts set out in this agreement and any other amounts'.split(' ');
  for (let i = 0; i < 24; i++) {
    const y = 730 - i * 14;
    // Left column 40–285, right column 305–555; the right column's headings start a little left of its text.
    const left = `L${i} ${words.slice(i % 5, i % 5 + 7).join(' ')}`, right = `R${i} ${words.slice(i % 4, i % 4 + 7).join(' ')}`;
    page.drawText(left, { x: 40, y, size: 9, font });
    if (i % 6 === 0) page.drawText(`${i}. Heading`, { x: 300, y, size: 9, font: bold });
    else page.drawText(right, { x: 312, y, size: 9, font });
  }
  const bytes = await doc.save();
  const lib = await PDFDocument.load(bytes);
  const js = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const layout = layoutPage(lib, 0, await pageTextItems(js as never, 1));
  assert.equal(layout.columns.length, 1, 'one column band');
  const band = layout.columns[0];
  assert.ok(band.rect.y + band.rect.h < 760, `the centred title is not part of the band ${JSON.stringify(band.rect)} ${JSON.stringify(band.cols)}`);
  const paragraphs = layout.items.filter((i): i is LayoutParagraph => i.kind === 'paragraph').map((p) => p.lines.map(lineText).join(' '));
  for (const p of paragraphs) assert.ok(!(/\bL\d+\b/.test(p) && /\b(R\d+|\d+\. Heading)\b/.test(p)), `no paragraph mixes the columns: ${p}`);
  assert.ok(paragraphs.some((p) => p.includes('6. Heading')), 'headings stay whole');
});
