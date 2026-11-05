import { test, expect, open, rendered, start, file, save, pdfInfo } from './helpers';

test.describe('F02 create, combine, images to PDF', () => {
  test('F02-H1 Create Blank opens a one-page document that saves', async ({ page, errors }) => {
    await start(page);
    await page.getByRole('button', { name: /Create Blank/ }).click();
    await rendered(page, 1);
    const out = await save(page);
    expect(out.name).toMatch(/\.pdf$/);
    expect((await pdfInfo(out.bytes)).numPages).toBe(1);
  });

  test('F02-H2 Combine two PDFs gives all pages in order', async ({ page, errors }) => {
    await start(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Combine Files/ }).click();
    await (await chooser).setFiles([file('report.pdf'), file('form.pdf')]);
    await rendered(page, 4);
    const info = await pdfInfo((await save(page)).bytes);
    expect(info.numPages).toBe(4);
    expect(info.pages[0]).toContain('Quarterly Report 1');
    expect(info.pages[3]).toContain('Full name');
  });

  test('F02-H3 Images to PDF makes a page per picture', async ({ page, errors }) => {
    await start(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Images to PDF/ }).click();
    await (await chooser).setFiles([file('photo.png'), file('photo.png')]);
    await rendered(page, 2);
  });

  test('F02-E1 Combine with the picker cancelled does nothing', async ({ page, errors }) => {
    await start(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Combine Files/ }).click();
    await (await chooser).setFiles([]);
    await expect(page.getByRole('heading', { name: 'MK PDF' })).toBeVisible();
  });
});
