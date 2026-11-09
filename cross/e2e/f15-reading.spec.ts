import { test, expect, openDoc, panel } from './helpers';

test.describe('F15 reading view', () => {
  test('F15-H1 headings, paragraphs and contents; page numbers left out @phone', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await page.getByTitle('Reading view', { exact: true }).click();
    const view = page.getByRole('dialog', { name: 'Reading view' });
    await expect(view.getByRole('heading', { name: 'Quarterly Report 1' })).toBeVisible();
    await expect(view.getByRole('heading')).toHaveCount(3);
    await expect(view.getByText('The quick brown fox jumps over the lazy dog. Account SECRET-123 is closed.').first()).toBeVisible();
    await expect(view.getByText(/^Page \d$/)).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // Contents jump to a heading.
    await view.getByRole('button', { name: 'Contents' }).click();
    await view.getByRole('navigation', { name: 'Contents' }).getByRole('button', { name: 'Quarterly Report 3' }).click();
    await expect(view.getByRole('heading', { name: 'Quarterly Report 3' })).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(view).toBeHidden();
  });

  test('F15-H2 text size and line spacing change and are remembered', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'More Tools');
    await page.getByRole('button', { name: /^Reading view Text reflowed/ }).click();
    const view = page.getByRole('dialog', { name: 'Reading view' });
    const text = view.locator('article');
    const px = async () => Number((await text.evaluate((e) => getComputedStyle(e).fontSize)).replace('px', ''));
    const before = await px();
    await view.getByRole('button', { name: 'Larger text' }).click();
    expect(await px()).toBe(before + 2);
    const lh = await text.evaluate((e) => e.style.lineHeight);
    await view.getByTitle(/^Line spacing/).click();
    expect(await text.evaluate((e) => e.style.lineHeight)).not.toBe(lh);
    await view.getByRole('button', { name: 'Close reading view' }).click();
    await page.getByTitle('Reading view', { exact: true }).click();
    expect(await px()).toBe(before + 2);
  });

  test('F15-E1 a scan without recognised text says how to read it', async ({ page, errors }) => {
    await openDoc(page, 'scan.pdf', 1);
    await page.getByTitle('Reading view', { exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Reading view' })).toContainText('is a scanned image');
  });
});
