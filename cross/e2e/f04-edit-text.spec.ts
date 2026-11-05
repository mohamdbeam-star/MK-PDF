import { test, expect, openDoc, save, pdfInfo } from './helpers';
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
