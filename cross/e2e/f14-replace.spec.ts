import { test, expect, openDoc, save, pdfInfo, toast, file } from './helpers';
import fs from 'node:fs';
import type { Page } from '@playwright/test';

async function replace(page: Page, find: string, by: string, o: { matchCase?: boolean; whole?: boolean } = {}) {
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('searchbox', { name: 'Search text' }).fill(find);
  await page.getByRole('button', { name: 'Replace…' }).click();
  await page.getByRole('textbox', { name: 'Replace with' }).fill(by);
  if (o.matchCase) await page.getByRole('checkbox', { name: 'Match case' }).check();
  if (o.whole) await page.getByRole('checkbox', { name: 'Whole words' }).check();
  await page.getByRole('button', { name: 'Replace all' }).click();
}

test.describe('F14 find and replace', () => {
  test('F14-H1 replace a word on every page, the rest of the text untouched', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await replace(page, 'SECRET-123', 'ACCT-9 é');
    await toast(page, 'Replaced 3 matches');
    const info = await pdfInfo((await save(page)).bytes);
    for (const [i, t] of info.pages.entries()) {
      expect(t).not.toContain('SECRET');
      expect(t).toContain('ACCT-9 é');
      expect(t).toContain('quick brown fox');
      expect(t).toContain(`Quarterly Report ${i + 1}`);
    }
  });

  test('F14-H2 one undo puts every page back', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await replace(page, 'closed', 'open');
    await toast(page, 'Replaced 3 matches');
    await page.getByRole('button', { name: /^Undo/ }).click();
    const info = await pdfInfo((await save(page)).bytes);
    for (const t of info.pages) expect(t).toContain('is closed.');
  });

  test('F14-E1 whole words only leaves longer words alone', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await replace(page, 'quic', 'x', { whole: true });
    await toast(page, /No matches/);
    await page.getByRole('button', { name: 'Hide replace' }).click();
    await replace(page, 'the', 'a', { whole: true });
    await toast(page, 'Replaced 6 matches'); // "The quick" and "the lazy" on each page; "other"-like words would not count
    const t = (await pdfInfo((await save(page)).bytes)).pages[0];
    expect(t).toContain('a quick brown fox');
    expect(t).toContain('over a lazy dog');
  });

  test('F14-E2 match case', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await replace(page, 'the', 'one', { matchCase: true });
    await toast(page, 'Replaced 3 matches');
    const t = (await pdfInfo((await save(page)).bytes)).pages[0];
    expect(t).toContain('The quick brown fox');
    expect(t).toContain('over one lazy dog');
  });

  test('F14-N1 no match changes nothing', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await replace(page, 'nowhere 🦊', 'x');
    await toast(page, /No matches/);
    await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled();
    await expect(page.locator('.tab-name')).toHaveText('report.pdf');
  });

  test('F14-E3 replaced text keeps the document font when it has the letters', async ({ page, errors }) => {
    test.skip(!fs.existsSync(file('own-font.pdf')), 'no system serif to embed on this machine');
    await openDoc(page, 'own-font.pdf', 1);
    await replace(page, 'lazy dog', 'sleepy hound');
    await toast(page, 'Replaced 1 match');
    const out = (await save(page)).bytes;
    expect((await pdfInfo(out)).pages[0]).toContain('jumps over the sleepy hound.');
    const { PDFDocument, PDFName, PDFDict } = await import('pdf-lib');
    const d = (await PDFDocument.load(out)).getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    expect(d.keys().map((k) => String(d.lookup(k, PDFDict).get(PDFName.of('BaseFont')))).filter((f) => /Noto/.test(f))).toEqual([]);
  });
});
