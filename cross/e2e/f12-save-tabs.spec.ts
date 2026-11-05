import { test, expect, openDoc, save, open, start, panel, pdfInfo, file } from './helpers';

test.describe('F12 save, tabs and closing', () => {
  test('F12-H1 save keeps the name and clears the unsaved dot', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Organize');
    await page.getByRole('button', { name: 'Reverse page order' }).click();
    await expect(page.locator('.tab-name')).toHaveText('● report.pdf');
    const out = await save(page);
    expect(out.name).toBe('report.pdf');
    await expect(page.locator('.tab-name')).toHaveText('report.pdf');
  });

  test('F12-E1 close an unsaved tab asks first; declining keeps it', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Organize');
    await page.getByRole('button', { name: 'Reverse page order' }).click();
    await page.evaluate(() => { window.confirm = () => false; });
    await page.locator('.tab-close').click();
    await expect(page.locator('.tab-name')).toHaveText('● report.pdf');
    await page.evaluate(() => { window.confirm = () => true; });
    await page.locator('.tab-close').click();
    await expect(page.getByRole('heading', { name: 'MK PDF' })).toBeVisible();
  });

  test('F12-E2 two documents: edits in one do not leak into the other', async ({ page, errors }) => {
    await start(page);
    await open(page, 'report.pdf', 'form.pdf');
    await expect(page.locator('.tab.on .tab-name')).toHaveText('form.pdf'); // both loaded
    await page.locator('.tab', { hasText: 'report.pdf' }).click();
    await panel(page, 'Organize');
    await page.getByRole('button', { name: 'Reverse page order' }).click();
    await page.locator('.tab', { hasText: 'form.pdf' }).click();
    await expect(page.locator('.tab', { hasText: 'form.pdf' }).locator('.tab-name')).toHaveText('form.pdf');
    const info = await pdfInfo((await save(page)).bytes);
    expect(info.numPages).toBe(1);
  });

  test('F12-E3 double click on Save writes one file', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    let n = 0;
    page.on('download', () => n++);
    await page.getByRole('button', { name: 'Save', exact: true }).dblclick();
    await page.waitForTimeout(2000);
    expect(n).toBe(1);
  });

  test('F12-E4 Ctrl+Tab switches tabs, Ctrl+W closes', async ({ page, errors }) => {
    await start(page);
    await open(page, 'report.pdf', 'form.pdf');
    await expect(page.locator('.tab.on .tab-name')).toHaveText('form.pdf');
    await page.keyboard.press('Control+Tab');
    await expect(page.locator('.tab.on .tab-name')).toHaveText('report.pdf');
    await page.keyboard.press('ControlOrMeta+w');
    await expect(page.locator('.tab-name')).toHaveText(['form.pdf']);
    void file;
  });
});
