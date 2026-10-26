import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLValidator } from 'fast-xml-parser';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { layoutPage, paragraphText, lineText } from '../src/engine/layout';
import { pageTextItems } from '../src/engine/textItems';
import { docx, xlsx, plainText, markdown, csv, rtf } from '../src/export/writers';

const SAMPLES = process.env.MKPDF_SAMPLES ?? '';

async function layouts(path: string) {
  const bytes = fs.readFileSync(path);
  const doc = await PDFDocument.load(bytes);
  const js = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const out = [];
  for (let i = 0; i < doc.getPageCount(); i++) out.push(layoutPage(doc, i, await pageTextItems(js as never, i + 1)));
  return out;
}

function checkPackage(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  for (const [name, data] of Object.entries(files)) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    const s = strFromU8(data);
    assert.ok(s.startsWith('<?xml'), `${name} has an XML header`);
    const v = XMLValidator.validate(s);
    assert.equal(v, true, `${name} is well-formed: ${JSON.stringify(v)}`);
  }
  return files;
}

if (SAMPLES) {
  test('quotation: paragraphs, tabbed line, table, exports', async () => {
    const [l] = await layouts(`${SAMPLES}/work/Orig.pdf`);
    const paras = l.items.filter((i) => i.kind === 'paragraph').map((p) => paragraphText(p as never));
    assert.ok(paras.some((t) => t.startsWith('Thank you for your enquiry') && t.includes('exclude VAT')), 'reflowed paragraph');
    assert.ok(paras.some((t) => t.includes('Date: 22 October 2026\tQuote No')), 'same-line pieces joined with a tab');
    const table = l.items.find((i) => i.kind === 'table') as never as { rows: unknown[][] };
    assert.ok(table && table.rows.length === 2, 'item table found');
    assert.ok(l.items.some((i) => i.kind === 'image'), 'logo found');
    const d = checkPackage(await docx([l]));
    assert.ok(strFromU8(d['word/document.xml']).includes('Total: 12,600 AED'));
    checkPackage(xlsx([l]));
    assert.ok(plainText([l]).includes('Authorised signature'));
    assert.ok((await markdown([l])).includes('# MK Trading LLC'));
    assert.ok(csv([l]).includes('"Standing desks"'));
    assert.ok(rtf([l]).startsWith('{\\rtf1'));
  });

  test('real Word PDF: lists split, wrapped cell joined, RTL-safe', async () => {
    const ls = await layouts(`${SAMPLES}/real/FTA decision No 13 for ITC conditions.pdf`);
    const paras = ls[0].items.filter((i) => i.kind === 'paragraph').map((p) => paragraphText(p as never));
    assert.ok(paras.filter((t) => t.startsWith('- ')).length >= 5, 'each bullet is its own paragraph');
    const tables = ls[0].items.filter((i) => i.kind === 'table') as never as { rows: ({ runs: { text: string }[] } | null)[][] }[];
    const cells = tables.flatMap((t) => t.rows.flat().filter(Boolean).map((c) => lineText(c as never)));
    assert.ok(cells.some((c) => c.includes('referred to above, and any other Federal Decree-Law replacing it')), 'wrapped cell joined');
    checkPackage(await docx(ls));
    checkPackage(xlsx(ls));
  });
}
