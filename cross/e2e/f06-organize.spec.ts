import { test, expect, openDoc, save, saved, pdfInfo, panel, answer, rendered, toast } from './helpers';

test.describe('F06 organize pages', () => {
  test('F06-H1 rotate, duplicate, insert blank and delete the current page', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Organize');
    await page.getByRole('button', { name: 'Back to document' }).click().catch(() => {});
    await page.getByRole('button', { name: /Right$/ }).click();
    let info = await pdfInfo((await save(page)).bytes);
    expect(info.rotation).toEqual([90, 0, 0]);
    await page.getByRole('button', { name: 'Duplicate page' }).click();
    await page.getByRole('button', { name: 'Insert blank page' }).click();
    info = await pdfInfo((await save(page)).bytes);
    expect(info.numPages).toBe(5);
    await page.locator('.panel .chips button', { hasText: 'Delete' }).click();
    info = await pdfInfo((await save(page)).bytes);
    expect(info.numPages).toBe(4);
  });

  test('F06-H2 reverse page order', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Organize');
    await page.getByRole('button', { name: 'Reverse page order' }).click();
    const info = await pdfInfo((await save(page)).bytes);
    expect(info.pages.map((t) => t.match(/Report (\d)/)?.[1])).toEqual(['3', '2', '1']);
  });

  test('F06-H3 extract pages 2-3 to a new file', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Organize');
    await page.getByRole('button', { name: 'Extract pages…' }).click();
    await answer(page, '2-3');
    await rendered(page, 2).catch(() => {});
    const out = await saved(page, () => page.getByRole('button', { name: 'Save', exact: true }).click());
    const info = await pdfInfo(out.bytes);
    expect(info.numPages).toBe(2);
    expect(info.pages[0]).toContain('Report 2');
  });

  test('F06-N1 extract with an impossible range does nothing harmful', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Organize');
    await page.getByRole('button', { name: 'Extract pages…' }).click();
    await answer(page, '7-9, abc');
    await expect(page.locator('.tab')).toHaveCount(3); // home + report + nothing new… or a clear message
  });

  test('F06-E1 deleting every page one by one stops at the last page', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Organize');
    for (let i = 0; i < 2; i++) { await page.locator('.panel .chips button', { hasText: 'Delete' }).click(); await expect(page.getByText(`/ ${2 - i}`)).toBeVisible(); }
    await page.locator('.panel .chips button', { hasText: 'Delete' }).click();
    await toast(page, /at least one page/);
    errors.length = 0; // the refusal is also logged
    const info = await pdfInfo((await save(page)).bytes);
    expect(info.numPages).toBeGreaterThanOrEqual(1);
  });
});
