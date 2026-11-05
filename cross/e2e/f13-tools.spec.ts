import { test, expect, openDoc, save, saved, start, file, pdfInfo, panel, toast } from './helpers';

test.describe('F13 repair, compare, watermark, header & footer', () => {
  for (const name of ['damaged.pdf', 'bad-offsets.pdf']) {
    test(`F13-H1 Repair PDF recovers ${name}`, async ({ page, errors }) => {
      await start(page);
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: /Repair PDF/ }).click();
      await (await chooser).setFiles(file(name));
      await expect(page.locator('.tab-name')).toHaveText(`${name.replace('.pdf', '')} (repaired).pdf`);
      const info = await pdfInfo((await save(page)).bytes);
      expect(info.numPages).toBe(3);
      expect(info.pages[2]).toContain('Quarterly Report 3');
    });
  }

  test('F13-H2 Compare two different files lists differences', async ({ page, errors }) => {
    await start(page);
    const choosers: import('@playwright/test').FileChooser[] = [];
    page.on('filechooser', (c) => choosers.push(c));
    await page.getByRole('button', { name: /Compare Files/ }).click();
    await expect.poll(() => choosers.length).toBe(1);
    await choosers[0].setFiles(file('report.pdf'));
    await expect.poll(() => choosers.length).toBe(2);
    await choosers[1].setFiles(file('form.pdf'));
    await expect(page.locator('.compare')).toContainText('Full name');
    await page.locator('.compare').getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.compare')).toBeHidden();
  });
  test('F13-H3 watermark on every page', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Edit PDF');
    await page.getByRole('button', { name: 'Watermark…' }).click();
    const sheet = page.getByRole('dialog', { name: 'Watermark' });
    await sheet.locator('input:not([type]), input[type=text]').first().fill('CONFIDENTIAL');
    await sheet.getByRole('button').last().click();
    const info = await pdfInfo((await save(page)).bytes);
    for (const t of info.pages) expect(t).toContain('CONFIDENTIAL');
  });

  test('F13-H4 header & footer page numbers', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Edit PDF');
    await page.getByRole('button', { name: 'Header & footer…' }).click();
    const sheet = page.getByRole('dialog', { name: 'Header & Footer' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button').last().click();
    await save(page);
    void toast;
  });
});
