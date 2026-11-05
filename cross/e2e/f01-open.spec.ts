import { test, expect, open, rendered, start, file, toast } from './helpers';
import fs from 'node:fs';

test.describe('F01 open a PDF', () => {
  test('F01-H1 open from Home shows the pages, title tab and recent entry', async ({ page, errors }) => {
    await start(page);
    await open(page, 'report.pdf');
    await rendered(page, 3);
    await expect(page.locator('.tab-name')).toHaveText('report.pdf');
    await expect(page.getByText('/ 3')).toBeVisible();
    await page.getByRole('button', { name: 'Home' }).click();
    await expect(page.locator('.recents')).toContainText('report.pdf');
  });

  test('F01-H2 drop a PDF on the window opens it', async ({ page, errors }) => {
    await start(page);
    const bytes = fs.readFileSync(file('report.pdf')).toString('base64');
    await page.evaluate(async (b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin], 'dropped.pdf', { type: 'application/pdf' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true }));
    }, bytes);
    await rendered(page, 3);
    await expect(page.locator('.tab-name')).toHaveText('dropped.pdf');
  });

  test('F01-E1 empty file shows a clear error and stays on Home', async ({ page, errors }) => {
    await start(page);
    await open(page, 'empty.pdf');
    await toast(page, /Couldn.t open empty\.pdf/);
    await expect(page.getByRole('heading', { name: 'MK PDF' })).toBeVisible();
    errors.length = 0; // the failure is logged by pdf.js; the toast is what the user sees
  });

  test('F01-N1 a text file named .pdf is refused', async ({ page, errors }) => {
    await start(page);
    await open(page, 'not-a-pdf.pdf');
    await toast(page, /Couldn.t open not-a-pdf\.pdf/);
    errors.length = 0;
  });

  test('F01-E2 accents, emoji and Arabic in the file name', async ({ page, errors }) => {
    await start(page);
    await open(page, 'Résumé 📄 تقرير.pdf');
    await rendered(page, 3);
    await expect(page.locator('.tab-name')).toHaveText('Résumé 📄 تقرير.pdf');
  });

  test('F01-E3 very long file name keeps the toolbar usable', async ({ page, errors }) => {
    await start(page);
    await open(page, `${'long-name-'.repeat(20)}.pdf`);
    await rendered(page, 3);
    const tab = await page.locator('.tab').nth(1).boundingBox();
    expect(tab!.width).toBeLessThan(400);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
  });

  test('F01-E4 several files at once open as tabs', async ({ page, errors }) => {
    await start(page);
    await open(page, 'report.pdf', 'form.pdf');
    await expect(page.locator('.tab-name')).toHaveText(['report.pdf', 'form.pdf']);
  });

  test('F01-E6 refresh with a document open returns to Home without errors', async ({ page, errors }) => {
    await start(page);
    await open(page, 'report.pdf');
    await rendered(page, 3);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'MK PDF' })).toBeVisible();
  });

  test('F01-E7 phone width: Home tiles fit and open works @phone', async ({ page, errors }) => {
    await start(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await open(page, 'report.pdf');
    await rendered(page, 3);
  });

  test('F01-E8 keyboard only: Ctrl+O opens the picker', async ({ page, errors }) => {
    await start(page);
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('ControlOrMeta+o');
    await (await chooser).setFiles(file('report.pdf'));
    await rendered(page, 3);
  });
});
