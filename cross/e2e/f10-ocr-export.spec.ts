import { test, expect, openDoc, save, saved, savedMany, pdfInfo, panel, toast } from './helpers';
import { unzipSync, strFromU8 } from 'fflate';

/** Text of the Word file's body plus its headers and footers (repeated page titles and numbers go there). */
const docxText = (bytes: Uint8Array) => Object.entries(unzipSync(bytes)).filter(([k]) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(k))
  .map(([, v]) => strFromU8(v)).join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test.describe('F10 recognize text in scans', () => {
  test.setTimeout(240_000);
  test('F10-H1 Scan & OCR makes the scanned page searchable', async ({ page, errors }) => {
    await openDoc(page, 'scan.pdf', 1);
    await panel(page, 'Scan & OCR');
    await page.getByRole('button', { name: 'Recognize text' }).click();
    await expect(page.locator('.busy')).toBeHidden({ timeout: 200_000 });
    const text = (await pdfInfo((await save(page)).bytes)).pages[0];
    expect(text).toMatch(/INVOICE/i);
    expect(text).toContain('4471');
  });

  test('F10-H2 edit mode on a scan offers Make This Page Editable', async ({ page, errors }) => {
    await openDoc(page, 'scan.pdf', 1);
    await page.getByRole('button', { name: 'Edit Text & Images' }).first().click();
    await expect(page.getByText('No editable text on this page')).toBeVisible();
    await page.getByRole('button', { name: 'Make This Page Editable' }).click();
    await expect(page.locator('.busy')).toBeHidden({ timeout: 200_000 });
    await expect(page.locator('.mk-block').first()).toBeVisible();
  });
});

test.describe('F11 export', () => {
  test.setTimeout(240_000);
  test('F11-H1 export to Word keeps the text', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Export');
    const out = await saved(page, () => page.getByRole('button', { name: /^Word \(\.docx\)/ }).click());
    expect(out.name).toBe('report.docx');
    const text = docxText(out.bytes);
    expect(text).toContain('Quarterly Report 1');
    expect(text).toContain('Quarterly Report 3');
    expect(text).toContain('SECRET-123');
  });

  test('F11-H2 every document format exports a non-empty file', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Export');
    const rows = page.locator('.panel .row').filter({ has: page.locator('small') });
    const titles = (await page.locator('.panel h4:has-text("Images")').evaluate((h) => {
      const out: string[] = []; let el = h.previousElementSibling;
      while (el && el.tagName !== 'H4') { if (el.matches('.row')) out.unshift(el.querySelector('.row-text span')!.textContent!); el = el.previousElementSibling; }
      return out;
    }));
    expect(titles.length).toBeGreaterThan(2);
    for (const t of titles) {
      const out = await saved(page, () => page.locator('.panel .row', { hasText: t }).first().click());
      expect(out.bytes.length, t).toBeGreaterThan(100);
    }
    void rows;
  });

  test('F11-H3 page images as PNG, one per page', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Export');
    const files = await savedMany(page, 3, () => page.getByRole('button', { name: 'PNG', exact: true }).click());
    expect(files.map((f) => f.name).sort()).toEqual(['report-1.png', 'report-2.png', 'report-3.png']);
  });

  test('F11-H4 export a scan to Word with recognition gives real text', async ({ page, errors }) => {
    await openDoc(page, 'scan.pdf', 1);
    await panel(page, 'Export');
    const ocr = page.locator('.panel label.check input[type=checkbox]').first();
    if (await ocr.count()) await ocr.check();
    const out = await saved(page, () => page.getByRole('button', { name: /^Word \(\.docx\)/ }).click());
    expect(docxText(out.bytes)).toMatch(/INVOICE/i);
  });

  test('F11-H5 compress gives a valid file', async ({ page, errors }) => {
    await openDoc(page, 'scan.pdf', 1);
    await panel(page, 'Compress');
    await page.getByRole('button', { name: 'Compress', exact: true }).last().click();
    await expect(page.locator('.busy')).toBeHidden({ timeout: 120_000 });
    const out = await save(page);
    expect((await pdfInfo(out.bytes)).numPages).toBe(1);
    void toast;
  });
});
