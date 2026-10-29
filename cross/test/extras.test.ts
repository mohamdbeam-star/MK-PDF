// Document operations shared by Windows, Android and iPhone (matching the Mac app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream, rgb } from 'pdf-lib';

// The app's build-time version and browser storage, which the annotation helpers read.
Object.assign(globalThis, { __APP_VERSION__: 'test', localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const extras = await import('../src/pdf/extras');
const annots = await import('../src/pdf/annots');

const pageText = (doc: PDFDocument, i: number) => {
  const contents = doc.getPage(i).node.Contents();
  const streams = contents && 'asArray' in contents ? (contents as never as { asArray(): unknown[] }).asArray().map((r) => doc.context.lookup(r as never)) : [contents];
  return streams.map((s) => (s instanceof PDFRawStream ? new TextDecoder().decode(decodePDFRawStream(s).decode()) : '')).join('\n');
};

test('comments are drawn into the page and removed; links stay', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  annots.addWhiteout(doc, 0, { x: 100, y: 100, w: 50, h: 20 });
  annots.addLink(doc, 0, { x: 10, y: 10, w: 40, h: 10 }, 'https://example.com');
  extras.flattenAnnotations(doc, 'all');
  const left = annots.listAnnots(doc);
  assert.equal(left.length, 1, 'only the link remains');
  assert.equal(left[0].subtype, 'Link');
  assert.match(pageText(doc, 0), /\/MKa[-\d]* Do/, 'the appearance is drawn as part of the page');
});

test('bookmarks can be added, listed, renamed and deleted, and split a document by chapter', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 5; i++) doc.addPage([300, 300]);
  extras.addBookmark(doc, 'Intro', 0);
  extras.addBookmark(doc, 'Chapter 2', 2);
  extras.addBookmark(doc, 'Extra', 4);
  let list = extras.listBookmarks(doc);
  assert.deepEqual(list.map((b) => [b.title, b.page]), [['Intro', 0], ['Chapter 2', 2], ['Extra', 4]]);
  extras.renameBookmark(doc, list[1].ref, 'Second');
  extras.deleteBookmark(doc, list[2].ref);
  list = extras.listBookmarks(doc);
  assert.deepEqual(list.map((b) => b.title), ['Intro', 'Second']);
  assert.deepEqual(extras.bookmarkGroups(doc).map((g) => g.pages), [[0, 1], [2, 3, 4]]);
  // Survives a save and reload.
  const again = await PDFDocument.load(await doc.save());
  assert.deepEqual(extras.listBookmarks(again).map((b) => b.title), ['Intro', 'Second']);
});

test('grayscale turns colour operators gray and keeps text as text', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 10, y: 10, width: 50, height: 50, color: rgb(1, 0, 0) });
  page.drawText('Red text', { x: 20, y: 200, size: 12, font, color: rgb(0, 0, 1) });
  const bytes = await doc.save();
  const gray = await PDFDocument.load(bytes);
  await extras.grayscale(gray);
  const text = pageText(gray, 0);
  assert.doesNotMatch(text, /\brg\b/, 'no RGB fills left');
  assert.match(text, /0\.3 g/, 'red becomes 30% gray');
  assert.match(text, /Tj/, 'text is still text');
});

test('PDF/X-3 output has an sRGB output intent and trim boxes', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  extras.pdfx3(doc);
  const again = await PDFDocument.load(await doc.save());
  const intents = again.catalog.lookup(PDFName.of('OutputIntents'));
  assert.ok(intents, 'output intents written');
  assert.ok(again.getPage(0).node.get(PDFName.of('TrimBox')), 'trim box set');
});

test('form fields can be renamed and deleted; a page can be replaced', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  doc.addPage([300, 300]);
  const form = doc.getForm();
  form.createTextField('name').addToPage(doc.getPage(0), { x: 10, y: 10, width: 100, height: 20 });
  form.createCheckBox('agree').addToPage(doc.getPage(0), { x: 10, y: 40, width: 12, height: 12 });
  extras.renameField(doc, 'name', 'full name');
  extras.deleteField(doc, 'agree');
  assert.deepEqual(extras.listFields(doc).map((f) => f.name), ['full name']);
  const other = await PDFDocument.create();
  other.addPage([500, 400]);
  await extras.replacePage(doc, 1, await other.save());
  assert.equal(doc.getPageCount(), 2);
  assert.equal(doc.getPage(1).getWidth(), 500, 'page 2 is the new one');
});

test('OpenDocument export is a valid package with the text, paragraphs and tables', async () => {
  const { unzipSync, strFromU8 } = await import('fflate');
  const { odt } = await import('../src/export/writers');
  const { layoutPage } = await import('../src/engine/layout');
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText('Quarterly report', { x: 72, y: 700, size: 18, font });
  const lib = await PDFDocument.load(await doc.save());
  const layout = layoutPage(lib, 0, [{ str: 'Quarterly report', x: 72, y: 700, w: 150, h: 18, rtl: false }]);
  const files = unzipSync(odt([layout]));
  assert.equal(Object.keys(files)[0], 'mimetype', 'mimetype comes first');
  assert.equal(strFromU8(files.mimetype), 'application/vnd.oasis.opendocument.text');
  const content = strFromU8(files['content.xml']);
  assert.match(content, /Quarterly report/);
  assert.match(content, /fo:font-weight="bold"/, 'keeps the bold style');
});
