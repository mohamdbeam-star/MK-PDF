// Shared setup for every spec: fails on console errors and 5xx responses, keeps the update check offline,
// and gives helpers to open files, catch saved files and read their text.
import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect, type Page, type Download } from '@playwright/test';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export const DATA = path.join(import.meta.dirname, '.data');
export const file = (name: string) => path.join(DATA, name);

export const test = base.extend<{ errors: string[] }>({
  errors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} on ${r.url()}`); });
    // The release check goes to GitHub; tests never reach it.
    await page.route(/github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.addInitScript(() => { window.confirm = () => true; });
    await use(errors);
    expect(errors, 'console errors / 5xx').toEqual([]);
  },
  page: async ({ page }, use) => { await use(page); },
});
export { expect };

/** Opens files through the Home screen's Open tile (or the + tab once a document is open). */
export async function open(page: Page, ...names: string[]) {
  const chooser = page.waitForEvent('filechooser');
  const home = page.getByRole('button', { name: /^Open\b/ });
  if (await home.isVisible().catch(() => false)) await home.click(); else await page.getByRole('button', { name: 'Open', exact: true }).click();
  await (await chooser).setFiles(names.map(file));
}

/** Waits for the open document's first page to render. */
export async function rendered(page: Page, pages = 1) {
  await expect(page.locator('.page canvas').first()).toBeVisible();
  await expect(page.locator('.page')).toHaveCount(pages);
}

export async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'MK PDF' })).toBeVisible();
}

/** Runs `act` and returns the file the app saves (a download in the browser build). */
export async function saved(page: Page, act: () => Promise<unknown>): Promise<{ name: string; bytes: Uint8Array; download: Download }> {
  const dl = page.waitForEvent('download');
  await act();
  const download = await dl;
  const p = await download.path();
  return { name: download.suggestedFilename(), bytes: new Uint8Array(fs.readFileSync(p)), download };
}

export async function savedMany(page: Page, count: number, act: () => Promise<unknown>) {
  const out: { name: string; bytes: Uint8Array }[] = [];
  const done = new Promise<void>((resolve) => {
    page.on('download', async (d) => { out.push({ name: d.suggestedFilename(), bytes: new Uint8Array(fs.readFileSync(await d.path())) }); if (out.length === count) resolve(); });
  });
  await act();
  await done;
  return out;
}

export async function pdfInfo(bytes: Uint8Array, password?: string) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), password, verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push((tc.items as { str: string }[]).map((t) => t.str).join(' ').replace(/\s+/g, ' ').trim());
  }
  const rotation = await Promise.all([...Array(doc.numPages).keys()].map(async (i) => (await doc.getPage(i + 1)).rotate));
  const annots = await Promise.all([...Array(doc.numPages).keys()].map(async (i) => (await (await doc.getPage(i + 1)).getAnnotations()).map((a) => a.subtype as string)));
  const meta = await doc.getMetadata();
  return { numPages: doc.numPages, pages, rotation, annots, info: meta.info as Record<string, unknown> };
}

/** Waits until the active tab shows unsaved changes (an edit has landed). */
export const edited = (page: Page) => expect(page.locator('.tab.on .tab-name')).toHaveText(/^● /);

/** Saves the active document with Ctrl+S and returns what was written. */
export async function save(page: Page) {
  await page.waitForTimeout(650); // saves closer together than a double click are ignored
  return saved(page, () => page.getByRole('button', { name: 'Save', exact: true }).click());
}

export async function toast(page: Page, text: string | RegExp) {
  await expect(page.getByRole('status')).toContainText(text);
}

/** Opens a tools panel tab by its title. */
export async function panel(page: Page, title: string) {
  const tab = page.locator(`.panel-tab[title="${title}"]`);
  if (!(await tab.isVisible().catch(() => false))) await page.getByRole('button', { name: 'All tools' }).click();
  await tab.click();
}

/** Opens a file on a fresh app and waits for it to render. */
export async function openDoc(page: Page, name: string, pages = 1) {
  await start(page);
  await open(page, name);
  await rendered(page, pages);
}

/** Drags across page `n` (0-based) between two points given as fractions of the page box. */
export async function dragOnPage(page: Page, n: number, from: [number, number], to: [number, number], steps = 8) {
  const box = (await page.locator('.page').nth(n).boundingBox())!;
  const at = (f: [number, number]) => [box.x + box.width * f[0], box.y + box.height * f[1]] as const;
  await page.mouse.move(...at(from));
  await page.mouse.down();
  await page.mouse.move(...at(to), { steps });
  await page.mouse.up();
}

export async function clickOnPage(page: Page, n: number, at: [number, number]) {
  const box = (await page.locator('.page').nth(n).boundingBox())!;
  await page.mouse.click(box.x + box.width * at[0], box.y + box.height * at[1]);
}

/** Answers the app's text prompt sheet. */
export async function answer(page: Page, value: string) {
  const input = page.locator('.sheet input').first();
  await expect(input).toBeVisible();
  await input.fill(value);
  await page.locator('.sheet').getByRole('button', { name: 'OK' }).click();
}

export const tool = (page: Page, title: string) => page.getByTitle(title, { exact: true }).first().click();
