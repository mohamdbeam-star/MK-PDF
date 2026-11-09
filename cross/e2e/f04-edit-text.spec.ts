import { test, expect, openDoc, save, pdfInfo, file } from './helpers';
import fs from 'node:fs';
import type { Page } from '@playwright/test';

async function editMode(page: Page) {
  await page.getByRole('button', { name: 'Edit Text & Images' }).first().click();
  await expect(page.locator('.mk-block').first()).toBeVisible();
}

/** Clicks the paragraph containing `text` on page 1 and returns the editor. */
async function editParagraph(page: Page, index: number | string) {
  const blocks = page.locator('.page').first().locator('.mk-block');
  await (typeof index === 'number' ? blocks.nth(index) : blocks.and(page.locator(`[title^="${index}"]`))).click();
  const editor = page.locator('.mk-editor');
  // The editor fills in its text and takes focus once the paragraph's font is ready.
  await expect(editor).toBeFocused();
  await expect(editor).not.toHaveText('');
  return editor;
}

test.describe('F04 edit existing text', () => {
  test('F04-H1 change a sentence, save, and the PDF holds the new text only', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await editMode(page);
    const editor = await editParagraph(page, 'The quick brown fox');
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially('The slow green turtle walks.');
    await page.locator('.mk-editbar').getByRole('button', { name: 'Done' }).click();
    await expect(editor).toBeHidden();
    await expect(page.locator('.tab-name')).toHaveText(/●/);
    const info = await pdfInfo((await save(page)).bytes);
    expect(info.pages[0]).toContain('The slow green turtle walks.');
    expect(info.pages[0]).not.toContain('quick brown fox');
    expect(info.pages[1]).toContain('quick brown fox');
  });

  test('F04-E1 accents and Arabic typed into an edit survive the save', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await editMode(page);
    const editor = await editParagraph(page, 0);
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially('Café déjà vu مرحبا');
    await page.locator('.mk-editbar').getByRole('button', { name: 'Done' }).click();
    const text = (await pdfInfo((await save(page)).bytes)).pages[0].normalize('NFKC');
    expect(text).toContain('Café déjà vu');
    expect(text.replace(/\s/g, '')).toContain('مرحبا');
  });

  test('F04-E2 very long replacement text wraps and stays on the page', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await editMode(page);
    const editor = await editParagraph(page, 1);
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially('word '.repeat(120).trim());
    await page.locator('.mk-editbar').getByRole('button', { name: 'Done' }).click();
    const text = (await pdfInfo((await save(page)).bytes)).pages[0];
    expect((text.match(/word/g) ?? []).length).toBe(120);
  });

  test('F04-E3 emptying a paragraph removes it', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await editMode(page);
    const editor = await editParagraph(page, 0);
    const old = (await editor.textContent())!.trim();
    await editor.press('ControlOrMeta+a');
    await editor.press('Backspace');
    await page.locator('.mk-editbar').getByRole('button', { name: 'Done' }).click();
    const text = (await pdfInfo((await save(page)).bytes)).pages[0];
    expect(text).not.toContain(old);
  });

  test('F04-E4 cancel (✕) leaves the page unchanged', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await editMode(page);
    const editor = await editParagraph(page, 0);
    await editor.pressSequentially(' extra');
    await page.locator('.mk-editbar').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.tab-name')).not.toHaveText(/●/);
  });

  test('F04-H2 undo and redo an edit', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await editMode(page);
    const editor = await editParagraph(page, 0);
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially('Changed title');
    await page.locator('.mk-editbar').getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('button', { name: /^Undo/ })).toBeEnabled();
    await page.getByRole('button', { name: /^Undo/ }).click();
    let text = (await pdfInfo((await save(page)).bytes)).pages[0];
    expect(text).not.toContain('Changed title');
    await page.getByRole('button', { name: /^Redo/ }).click();
    text = (await pdfInfo((await save(page)).bytes)).pages[0];
    expect(text).toContain('Changed title');
  });

  test('F04-E5 edit the same paragraph twice (re-editable)', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await editMode(page);
    let editor = await editParagraph(page, 0);
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially('First edit');
    await page.locator('.mk-editbar').getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.page').first().locator('.mk-block').first()).toBeVisible();
    editor = await editParagraph(page, 0);
    await expect(editor).toContainText('First edit');
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially('Second edit');
    await page.locator('.mk-editbar').getByRole('button', { name: 'Done' }).click();
    const text = (await pdfInfo((await save(page)).bytes)).pages[0];
    expect(text).toContain('Second edit');
    expect(text).not.toContain('First edit');
  });

  test('F04-E6 bold and bigger via the style bar', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await editMode(page);
    await editParagraph(page, 1);
    const bar = page.locator('.mk-editbar');
    const size = Number(await bar.locator('.mk-size').textContent());
    await bar.getByRole('button', { name: 'A+' }).click();
    await bar.getByRole('button', { name: 'B', exact: true }).click();
    await expect(bar.locator('.mk-size')).toHaveText((size + 1).toFixed(1));
    await bar.getByRole('button', { name: 'Done' }).click();
    await save(page);
  });

  test('F04-E7 phone width: edit a paragraph @phone', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await editMode(page);
    const editor = await editParagraph(page, 0);
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially('Phone edit');
    await page.locator('.mk-editbar').getByRole('button', { name: 'Done' }).click();
    expect((await pdfInfo((await save(page)).bytes)).pages[0]).toContain('Phone edit');
  });
});

test.describe('F04 edits keep the document font', () => {
  /** Font dictionaries on page 1 and their base font names. */
  async function fonts(bytes: Uint8Array) {
    const { PDFDocument, PDFName, PDFDict } = await import('pdf-lib');
    const doc = await PDFDocument.load(bytes);
    const dict = doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    return dict.keys().map((k) => String(dict.lookup(k, PDFDict).get(PDFName.of('BaseFont'))));
  }

  test('F04-H3 an edit whose letters are all in the embedded font is written in it', async ({ page, errors }) => {
    test.skip(!fs.existsSync(file('own-font.pdf')), 'no system serif to embed on this machine');
    await openDoc(page, 'own-font.pdf', 1);
    await editMode(page);
    const editor = await editParagraph(page, 'The quick brown fox');
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially('The slow green turtle walks.');
    await page.locator('.mk-editbar').getByRole('button', { name: 'Done' }).click();
    const out = (await save(page)).bytes;
    const text = (await pdfInfo(out)).pages[0];
    expect(text).toContain('The slow green turtle walks.');
    expect(text).not.toContain('quick brown');
    // Only the document's own font on the page: no substitute was added for the edit.
    const list = await fonts(out);
    expect(list.filter((f) => /Noto|Helvetica|Times/.test(f))).toEqual([]);
  });

  test('F04-E8 letters the embedded font lacks fall back to a full font', async ({ page, errors }) => {
    test.skip(!fs.existsSync(file('own-font.pdf')), 'no system serif to embed on this machine');
    await openDoc(page, 'own-font.pdf', 1);
    await editMode(page);
    const editor = await editParagraph(page, 'The quick brown fox');
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially('Zebra 42! Ψ');
    await page.locator('.mk-editbar').getByRole('button', { name: 'Done' }).click();
    const out = (await save(page)).bytes;
    expect((await pdfInfo(out)).pages[0]).toContain('Zebra 42! Ψ');
    expect((await fonts(out)).some((f) => /Noto/.test(f))).toBe(true);
  });
});

test.describe('F04 text box width', () => {
  /** Lines (distinct baselines) holding the sentence's words on page 1, and the words read back in order. */
  async function sentence(bytes: Uint8Array) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    const items = (await (await doc.getPage(1)).getTextContent()).items as { str: string; transform: number[] }[];
    const words = /quick|brown|fox|jumps|over|lazy|dog|Account|SECRET|closed/;
    const mine = items.filter((i) => words.test(i.str));
    return { lines: new Set(mine.map((i) => Math.round(i.transform[5]))).size, text: mine.map((i) => i.str).join(' ').replace(/\s+/g, ' ') };
  }

  test('F04-H4 narrowing a paragraph reflows its text onto more lines, same words', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await editMode(page);
    const block = page.locator('.page').first().locator('.mk-block[title^="The quick"]');
    await block.hover();
    const h = (await block.locator('.mk-width').boundingBox())!;
    const w = (await block.boundingBox())!.width;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x - w * 0.65, h.y + h.height / 2, { steps: 8 });
    await expect(page.locator('.mk-preview')).toBeVisible();
    await page.mouse.up();
    await expect(page.getByRole('button', { name: 'Undo Resize Text Box' })).toBeEnabled();
    const s = await sentence((await save(page)).bytes);
    expect(s.lines).toBeGreaterThanOrEqual(4);
    for (const word of ['quick', 'brown', 'fox', 'jumps', 'lazy', 'dog.', 'Account', 'SECRET-123', 'closed.']) expect(s.text).toContain(word);
  });

  test('F04-E9 Shift keeps a moved paragraph level', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await editMode(page);
    const block = page.locator('.page').first().locator('.mk-block[title^="The quick"]');
    const b = (await block.boundingBox())!;
    await page.mouse.move(b.x + 30, b.y + b.height / 2);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    await page.mouse.move(b.x + 150, b.y + b.height / 2 + 12, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect(page.getByRole('button', { name: 'Undo Move Text' })).toBeEnabled();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: (await save(page)).bytes.slice(), verbosity: 0 }).promise;
    const items = (await (await doc.getPage(1)).getTextContent()).items as { str: string; transform: number[] }[];
    const first = items.find((i) => i.str.includes('quick'))!;
    expect(Math.round(first.transform[5])).toBe(650); // same baseline, moved only sideways
    expect(first.transform[4]).toBeGreaterThan(100);
  });
});
