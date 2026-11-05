import { test, expect, openDoc, save, pdfInfo, panel, start, open, answer, rendered, toast } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './helpers';

test.describe('F08 redact', () => {
  test('F08-H1 mark all matches and apply removes the text from every page', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Redact');
    await page.getByPlaceholder('Text, email, number…').fill('SECRET-123');
    await page.getByRole('button', { name: 'Mark all matches' }).click();
    await toast(page, 'Marked 3 matches');
    await page.getByRole('button', { name: 'Apply redactions' }).click();
    const info = await pdfInfo((await save(page)).bytes);
    for (const t of info.pages) { expect(t).not.toContain('SECRET'); expect(t).toContain('quick brown fox'); }
  });

  test('F08-N1 no matches says so', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Redact');
    await page.getByPlaceholder('Text, email, number…').fill('nowhere-🦊');
    await page.getByRole('button', { name: 'Mark all matches' }).click();
    await toast(page, /No matches/);
  });

  test('F08-H2 remove metadata clears title and author', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Redact');
    await page.getByRole('button', { name: /Remove metadata/ }).click();
    const info = await pdfInfo((await save(page)).bytes);
    expect(info.info.Title ?? '').toBe('');
    expect(info.info.Author ?? '').toBe('');
  });
});

test.describe('F09 password protect', () => {
  test('F09-H1 protect, save, reopen asks for the password', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Protect');
    await page.getByPlaceholder('Password', { exact: true }).fill('s3cret pässword');
    await page.getByPlaceholder('Confirm password').fill('s3cret pässword');
    await page.getByRole('button', { name: 'Apply protection' }).click();
    const out = await save(page);
    await expect(pdfInfo(out.bytes)).rejects.toThrow();
    expect((await pdfInfo(out.bytes, 's3cret pässword')).numPages).toBe(3);
    fs.writeFileSync(path.join(DATA, 'locked.pdf'), out.bytes);

    await start(page);
    await open(page, 'locked.pdf');
    await answer(page, 'wrong');
    await toast(page, 'Incorrect password');
    await open(page, 'locked.pdf');
    await answer(page, 's3cret pässword');
    await rendered(page, 3);
    errors.length = 0; // pdf.js logs the refused password
  });

  test('F09-N1 mismatched passwords are refused', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Protect');
    await page.getByPlaceholder('Password', { exact: true }).fill('one');
    await page.getByPlaceholder('Confirm password').fill('two');
    await page.getByRole('button', { name: 'Apply protection' }).click();
    await toast(page, "Passwords don't match");
  });
});
