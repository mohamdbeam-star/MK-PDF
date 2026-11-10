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
    // Edit mode redraws its paragraphs after the edit lands; the new one carries the new text.
    await expect(page.locator('.page').first().locator('.mk-block[title^="First edit"]')).toBeVisible();
    editor = await editParagraph(page, 'First edit');
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
    await bar.getByRole('button', { name: 'Larger' }).click();
    await bar.getByRole('button', { name: 'Bold' }).click();
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

test.describe('F04 text style bar', () => {
  /** Text items of page 1 with position and width. */
  async function items(bytes: Uint8Array) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    return ((await (await doc.getPage(1)).getTextContent()).items as { str: string; transform: number[]; width: number }[])
      .filter((i) => i.str.trim()).map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width }));
  }
  async function content(bytes: Uint8Array) {
    const { PDFDocument, PDFName, PDFArray, PDFRawStream, decodePDFRawStream } = await import('pdf-lib');
    const page = (await PDFDocument.load(bytes)).getPage(0);
    const c = page.node.Contents();
    const list = c instanceof PDFArray ? [...Array(c.size()).keys()].map((i) => c.lookup(i)) : [c];
    void PDFName;
    return list.map((s) => (s instanceof PDFRawStream ? new TextDecoder('latin1').decode(decodePDFRawStream(s).decode()) : '')).join('\n');
  }
  async function styled(page: Page, text: string, apply: (bar: import('@playwright/test').Locator) => Promise<void>) {
    await openDoc(page, 'report.pdf', 3);
    await editMode(page);
    const editor = await editParagraph(page, 'The quick brown fox');
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially(text);
    const bar = page.locator('.mk-editbar');
    await apply(bar);
    await bar.getByRole('button', { name: 'Done' }).click();
    return (await save(page)).bytes;
  }
  const LONG = 'Justified text spreads the words of every line except the last so both edges line up neatly across the whole paragraph without ragged right margins at all';

  test('F04-H5 justify: every line but the last ends at the same right edge', async ({ page, errors }) => {
    const out = await styled(page, LONG, (bar) => bar.getByRole('button', { name: 'Align justify' }).click());
    const lines = new Map<number, { right: number; words: string[] }>();
    for (const i of await items(out)) if (/Justified|spreads|words|line|edges|paragraph|margins|neatly|whole|ragged|right|every|except|last|both|across|without|the|so|up|of|at|all|text/.test(i.str) && i.y > 560 && i.y < 660) {
      const l = lines.get(Math.round(i.y)) ?? { right: 0, words: [] };
      l.right = Math.max(l.right, i.x + i.w); l.words.push(i.str); lines.set(Math.round(i.y), l);
    }
    const sorted = [...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, l]) => l);
    expect(sorted.length).toBeGreaterThanOrEqual(3);
    const full = sorted.slice(0, -1).map((l) => l.right);
    expect(Math.max(...full) - Math.min(...full)).toBeLessThan(1.5);
    expect(sorted[sorted.length - 1].right).toBeLessThan(Math.min(...full) - 5);
    const words = sorted.flatMap((l) => l.words).join(' ').split(/\s+/);
    expect(words).toEqual(LONG.split(' '));
  });

  test('F04-E10 underline draws a rule under the text', async ({ page, errors }) => {
    // Filled paths on the page, with and without underline for the same edit.
    const fills = async (bytes: Uint8Array) => (await content(bytes)).match(/^f\*?$/gm)?.length ?? 0;
    const plain = await fills(await styled(page, 'Underlined words', async () => {}));
    const out = await styled(page, 'Underlined words', (bar) => bar.getByRole('button', { name: 'Underline' }).click());
    expect(await fills(out)).toBe(plain + 1);
    expect((await items(out)).map((i) => i.str).join(' ')).toContain('Underlined words');
  });

  test('F04-E11 double line spacing doubles the gap between lines', async ({ page, errors }) => {
    const gap = async (bytes: Uint8Array) => {
      const ys = [...new Set((await items(bytes)).filter((i) => i.y > 500 && i.y < 660).map((i) => Math.round(i.y)))].sort((a, b) => b - a);
      return ys[0] - ys[1];
    };
    const single = await gap(await styled(page, LONG, async () => {}));
    const double = await gap(await styled(page, LONG, (bar) => bar.getByRole('combobox', { name: 'Line spacing' }).selectOption('2')));
    expect(double).toBeGreaterThan(single * 1.8);
    expect(double).toBeLessThan(single * 2.2);
  });

  test('F04-E12 the font menu changes the font', async ({ page, errors }) => {
    const out = await styled(page, 'Typewriter text', (bar) => bar.getByRole('combobox', { name: 'Font' }).selectOption('Courier New'));
    const { PDFDocument, PDFName, PDFDict } = await import('pdf-lib');
    const d = (await PDFDocument.load(out)).getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    expect(d.keys().map((k) => String(d.lookup(k, PDFDict).get(PDFName.of('BaseFont')))).some((f) => /Courier|Mono/.test(f))).toBe(true);
  });

  async function typed(page: Page, lines: string[], apply: (bar: import('@playwright/test').Locator) => Promise<void>) {
    await openDoc(page, 'report.pdf', 3);
    await editMode(page);
    const editor = await editParagraph(page, 'The quick brown fox');
    await editor.press('ControlOrMeta+a');
    for (const [k, l] of lines.entries()) { if (k) await editor.press('Enter'); await editor.pressSequentially(l); }
    const bar = page.locator('.mk-editbar');
    await apply(bar);
    await bar.getByRole('button', { name: 'Done' }).click();
    return (await save(page)).bytes;
  }
  /** Baselines (top first) of the items holding these words, and the marker items in reading order. */
  async function rows(bytes: Uint8Array, words: string[]) {
    const all = (await items(bytes)).filter((i) => i.y > 450 && i.y < 670);
    const ys = words.map((w) => Math.round(all.find((i) => i.str.includes(w))!.y));
    const markers = all.map((i) => ({ y: i.y, m: /^(•|\d+\.)(?=\s|$)/.exec(i.str.trim())?.[1] })).filter((i) => i.m).sort((a, b) => b.y - a.y).map((i) => i.m);
    const left = (w: string) => all.find((i) => i.str.includes(w))!.x;
    return { ys, markers, left };
  }

  test('F04-H6 bulleted list: a bullet per paragraph, text indented', async ({ page, errors }) => {
    const out = await typed(page, ['Apples', 'Pears', 'Plums'], (bar) => bar.getByRole('button', { name: 'Bulleted list' }).click());
    const r = await rows(out, ['Apples', 'Pears', 'Plums']);
    expect(r.markers).toEqual(['•', '•', '•']);
    expect(r.left('Apples')).toBeGreaterThan(72 + 8);
  });

  test('F04-E13 numbered list counts 1, 2, 3 and keeps typed numbers single', async ({ page, errors }) => {
    const out = await typed(page, ['1. First', 'Second', 'Third'], (bar) => bar.getByRole('button', { name: 'Numbered list' }).click());
    const r = await rows(out, ['First', 'Second', 'Third']);
    expect(r.markers).toEqual(['1.', '2.', '3.']);
    expect((await items(out)).map((i) => i.str).join(' ').replace(/\s+/g, ' ')).not.toMatch(/1\.\s*1\./);
  });

  test('F04-E14 space after paragraphs widens the gap between them', async ({ page, errors }) => {
    const gaps = async (bytes: Uint8Array) => { const { ys } = await rows(bytes, ['Alpha', 'Beta']); return ys[0] - ys[1]; };
    const plain = await gaps(await typed(page, ['Alpha', 'Beta'], async () => {}));
    const spaced = await gaps(await typed(page, ['Alpha', 'Beta'], (bar) => bar.getByRole('combobox', { name: 'Space after paragraphs' }).selectOption('12')));
    expect(spaced - plain).toBeGreaterThan(11);
    expect(spaced - plain).toBeLessThan(13);
  });

  test('F04-E15 letter spacing and letter width change how wide the text is', async ({ page, errors }) => {
    // Everything on the edited line (spaced letters may come back one item each).
    const width = async (bytes: Uint8Array) => (await items(bytes)).filter((i) => Math.abs(i.y - 650) < 3)
      .reduce((a, i) => ({ l: Math.min(a.l, i.x), r: Math.max(a.r, i.x + i.w) }), { l: Infinity, r: -Infinity });
    const text = 'Spaced letters';
    const plain = await width(await styled(page, text, async () => {}));
    const spacedBytes = await styled(page, text, (bar) => bar.getByRole('combobox', { name: 'Letter spacing' }).selectOption('0.06'));
    // Still reads as words, so search and copy work.
    expect((await pdfInfo(spacedBytes)).pages[0]).toContain('Spaced letters');
    const spacedOut = await width(spacedBytes);
    const wide = await width(await styled(page, text, (bar) => bar.getByRole('combobox', { name: 'Letter width' }).selectOption('120')));
    const w = plain.r - plain.l;
    const extra = 0.06 * 14 * (text.length - 1); // 6% of the 14 pt size between letters (readers leave out the last)
    expect(spacedOut.r - spacedOut.l).toBeGreaterThan(w + extra - 2);
    expect(spacedOut.r - spacedOut.l).toBeLessThan(w + extra + 2);
    expect((wide.r - wide.l) / w).toBeGreaterThan(1.17);
    expect((wide.r - wide.l) / w).toBeLessThan(1.23);
  });

  test('F04-E16 superscript and subscript on selected characters', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await editMode(page);
    const editor = await editParagraph(page, 'The quick brown fox');
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially('Area 25 m2 of H2O');
    const bar = page.locator('.mk-editbar');
    /** Selects characters [from, to) of the editor's text. */
    const select = (from: number, to: number) => editor.evaluate((el, [a, b]) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const at = (n: number) => { let node: Node | null, left = n; while ((node = walk.nextNode())) { const len = node.textContent!.length; if (left <= len) return [node, left] as const; left -= len; } return [el, 0] as const; };
      const [sn, so] = at(a); walk.currentNode = el; const [en, eo] = at(b);
      const r = document.createRange(); r.setStart(sn, so); r.setEnd(en, eo);
      const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(r);
    }, [from, to] as const);
    const text = 'Area 25 m2 of H2O';
    await select(text.indexOf('m2') + 1, text.indexOf('m2') + 2);
    await bar.getByRole('button', { name: 'Superscript' }).click();
    await select(text.indexOf('H2O') + 1, text.indexOf('H2O') + 2);
    await bar.getByRole('button', { name: 'Subscript' }).click();
    await expect(editor).toHaveText('Area 25 m² of H₂O');
    await bar.getByRole('button', { name: 'Done' }).click();
    expect((await pdfInfo((await save(page)).bytes)).pages[0].normalize('NFC')).toContain('Area 25 m² of H₂O');
  });

  test('F04-N1 a capital letter cannot be raised', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await editMode(page);
    const editor = await editParagraph(page, 'The quick brown fox');
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially('TM');
    await page.keyboard.press('Shift+Home');
    await page.locator('.mk-editbar').getByRole('button', { name: 'Superscript' }).click();
    await expect(page.getByRole('status')).toContainText('can be raised or lowered');
    await expect(editor).toHaveText('TM');
  });
});
