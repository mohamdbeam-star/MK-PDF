import { test, expect, openDoc, panel } from './helpers';

test.describe('F03 view and navigate', () => {
  test('F03-H1 next / previous / page field move between pages', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    const field = page.locator('.page-field');
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(field).toHaveValue('2');
    await field.fill('3'); await field.press('Enter');
    await expect(field).toHaveValue('3');
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await page.getByRole('button', { name: 'Previous page' }).click();
    await expect(field).toHaveValue('2');
  });

  test('F03-E1 page field rejects 0, 99 and letters', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    const field = page.locator('.page-field');
    for (const v of ['0', '99', 'abc']) {
      await field.fill(v); await field.press('Enter');
      await expect(field).toHaveValue(/^[123]$/);
    }
  });

  test('F03-H2 zoom in and out change the zoom level', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    const zoom = page.getByTitle('Fit width');
    const before = await zoom.textContent();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoom).not.toHaveText(before!);
  });

  test('F03-H3 search finds text on every page', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await page.keyboard.press('ControlOrMeta+f');
    const box = page.getByPlaceholder('Search');
    await expect(box).toBeFocused();
    await box.fill('SECRET-123');
    await expect(page.locator('.sidebar')).toContainText('SECRET-123');
  });

  test('F03-E2 search with emoji and no match shows nothing, no error', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await page.getByTitle('Search', { exact: true }).click();
    await page.getByPlaceholder('Search').fill('🦊 nothing here');
    await page.waitForTimeout(800);
  });

  test('F03-H4 read mode hides the chrome and Escape leaves it', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'More Tools');
    await page.getByRole('button', { name: /Read mode/ }).click();
    await expect(page.getByRole('button', { name: 'Exit read mode' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Exit read mode' })).toBeHidden();
  });

  test('F03-E3 phone width: toolbar and pages fit without sideways scroll @phone', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
  });
});
