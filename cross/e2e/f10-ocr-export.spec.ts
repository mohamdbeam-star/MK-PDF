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

test.describe('F10 review uncertain words', () => {
  test.setTimeout(240_000);
  test('F10-H3 uncertain words are offered for review and corrections are saved', async ({ page, errors }) => {
    await openDoc(page, 'scan-hard.pdf', 1);
    await panel(page, 'Scan & OCR');
    // English only: without Arial (Linux) the worn word can otherwise be read as Arabic.
    await page.getByRole('combobox', { name: 'Language' }).selectOption('eng');
    await page.getByRole('button', { name: 'Recognize text' }).click();
    const review = page.getByRole('dialog', { name: 'Review recognized text' });
    await expect(review).toBeVisible({ timeout: 200_000 });
    await expect(review.getByRole('img')).toBeVisible();
    const field = review.getByRole('textbox', { name: 'Recognized as' });
    await field.fill('CORRECTED');
    await review.getByRole('button', { name: /^(Accept|Done)$/ }).click();
    // Any further uncertain words are kept as recognised.
    if (await review.isVisible()) await review.getByRole('button', { name: 'Accept all' }).click();
    await expect(review).toBeHidden();
    await toast(page, /reviewed \d+ uncertain/);
    const text = (await pdfInfo((await save(page)).bytes)).pages[0];
    expect(text).toContain('CORRECTED');
    expect(text).toMatch(/DELIVERY/);
  });

  test('F10-E1 a clean scan has nothing to review', async ({ page, errors }) => {
    await openDoc(page, 'scan.pdf', 1);
    await panel(page, 'Scan & OCR');
    await page.getByRole('button', { name: 'Recognize text' }).click();
    await toast(page, /Recognized \d+ lines? of text\.$/);
    await expect(page.getByRole('dialog', { name: 'Review recognized text' })).toHaveCount(0);
  });
});

/** In the page thumbnail: how far the long rule near the bottom climbs from its left end to its right end (pixels),
 *  and how bright a blank patch of paper is. */
async function ruleTilt(page: import('@playwright/test').Page) {
  const img = page.locator('.thumb img').first();
  await expect(img).toBeVisible();
  return img.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    const c = document.createElement('canvas');
    c.width = el.naturalWidth; c.height = el.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(el, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
    const dark = (x: number, y: number) => { const i = (y * width + x) * 4; return data[i] + data[i + 1] + data[i + 2] < 300; };
    const meanY = (x0: number, x1: number) => {
      let s = 0, n = 0;
      for (let y = Math.round(height * 0.62); y < Math.round(height * 0.9); y++) for (let x = x0; x < x1; x++) if (dark(x, y)) { s += y; n++; }
      return n ? s / n : NaN;
    };
    const left = meanY(Math.round(width * 0.2), Math.round(width * 0.3)), right = meanY(Math.round(width * 0.7), Math.round(width * 0.8));
    const i = (Math.round(height * 0.95) * width + Math.round(width * 0.5)) * 4;
    return { climb: left - right, paper: (data[i] + data[i + 1] + data[i + 2]) / 3 };
  });
}

test.describe('F10 straighten and clean up scans', () => {
  test.setTimeout(240_000);
  test('F10-H4 a crooked, yellowed scan is straightened and whitened before recognition', async ({ page, errors }) => {
    await openDoc(page, 'scan-tilted.pdf', 1);
    const before = await ruleTilt(page);
    expect(before.climb).toBeGreaterThan(4);
    expect(before.paper).toBeLessThan(235);
    await panel(page, 'Scan & OCR');
    await expect(page.getByRole('checkbox', { name: 'Straighten and clean up scans first' })).toBeChecked();
    await page.getByRole('button', { name: 'Recognize text' }).click();
    const review = page.getByRole('dialog', { name: 'Review recognized text' });
    await expect(page.getByRole('status').or(review)).toBeVisible({ timeout: 200_000 });
    if (await review.isVisible()) await review.getByRole('button', { name: 'Accept all' }).click();
    await toast(page, /straightened 1 page/);
    const after = await ruleTilt(page);
    expect(Math.abs(after.climb)).toBeLessThan(1.5);
    expect(after.paper).toBeGreaterThan(245);
    const text = (await pdfInfo((await save(page)).bytes)).pages[0];
    expect(text).toContain('PURCHASE ORDER 5150');
    expect(text).toContain('3400');
  });

  test('F10-E2 with clean-up off the scan stays as it was', async ({ page, errors }) => {
    await openDoc(page, 'scan-tilted.pdf', 1);
    await panel(page, 'Scan & OCR');
    await page.getByRole('checkbox', { name: 'Straighten and clean up scans first' }).uncheck();
    await page.getByRole('button', { name: 'Recognize text' }).click();
    const review = page.getByRole('dialog', { name: 'Review recognized text' });
    await expect(page.getByRole('status').or(review)).toBeVisible({ timeout: 200_000 });
    if (await review.isVisible()) await review.getByRole('button', { name: 'Accept all' }).click();
    await toast(page, /Recognized/);
    expect((await ruleTilt(page)).climb).toBeGreaterThan(4);
  });
});

test.describe('F11 Word export as flowing text', () => {
  test('F11-H6 flowing text: one section, normal spacing, every page title kept, page numbers as a field', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Export');
    await page.getByRole('combobox', { name: 'Word layout' }).selectOption('flow');
    const out = await saved(page, () => page.getByRole('button', { name: /^Word \(\.docx\)/ }).click());
    const files = unzipSync(out.bytes);
    const body = strFromU8(files['word/document.xml']);
    expect(body.match(/<w:sectPr/g)).toHaveLength(1);
    expect(body).not.toContain('lineRule="exact"');
    const text = docxText(out.bytes);
    for (const n of [1, 2, 3]) expect(text).toContain(`Quarterly Report ${n}`);
    expect(body).toContain('Heading1');
    expect(Object.entries(files).some(([k, v]) => /^word\/footer\d*\.xml$/.test(k) && strFromU8(v).includes(' PAGE '))).toBe(true);
  });
});
