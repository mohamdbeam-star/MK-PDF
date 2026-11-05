import { test, expect, openDoc, save, pdfInfo, panel, dragOnPage, clickOnPage, tool, edited, toast } from './helpers';
import { PDFDocument } from 'pdf-lib';

test.describe('F07 fill forms and sign', () => {
  test('F07-H1 type into a form field and the saved file keeps the value', async ({ page, errors }) => {
    await openDoc(page, 'form.pdf', 1);
    const field = page.locator('.annotationLayer input[type="text"]').first();
    const fb = (await field.boundingBox())!;
    await page.mouse.click(fb.x + 20, fb.y + fb.height / 2);
    await expect(field).toBeFocused();
    await field.fill('Zoë Ångström محمد');
    // A real click, as a user would: nothing may sit on top of the field.
    const cb = page.locator('.annotationLayer input[type="checkbox"]').first();
    const b = (await cb.boundingBox())!;
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await expect(cb).toBeChecked();
    await page.locator('.page').first().click({ position: { x: 20, y: 20 } });
    const doc = await PDFDocument.load((await save(page)).bytes);
    expect(doc.getForm().getTextField('FullName').getText()).toBe('Zoë Ångström محمد');
    expect(doc.getForm().getCheckBox('Agree').isChecked()).toBe(true);
  });

  test('F07-H2 draw a signature, place it, saved as a stamp', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await page.getByTitle('Fill & Sign').first().click();
    await page.getByRole('button', { name: 'Signature' }).click();
    const sheet = page.getByRole('dialog', { name: 'Add Signature' });
    await expect(sheet).toBeVisible();
    const pad = sheet.locator('canvas').first();
    const b = (await pad.boundingBox())!;
    await page.mouse.move(b.x + 20, b.y + b.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + b.width - 20, b.y + b.height / 3, { steps: 10 }); await page.mouse.up();
    await sheet.getByRole('button', { name: 'Save and place' }).click();
    await toast(page, 'Tap the page');
    await clickOnPage(page, 0, [0.6, 0.4]);
    await edited(page);
    expect((await pdfInfo((await save(page)).bytes)).annots[0]).toContain('Stamp');
  });

  test('F07-H3 add a text field from Prepare Form', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Prepare Form');
    await tool(page, 'Text Field');
    await dragOnPage(page, 0, [0.2, 0.5], [0.6, 0.54]);
    const doc = await PDFDocument.load((await save(page)).bytes);
    expect(doc.getForm().getFields().length).toBe(1);
  });

  test('F07-H4 flatten form makes values part of the page', async ({ page, errors }) => {
    await openDoc(page, 'form.pdf', 1);
    await page.locator('.annotationLayer input[type="text"]').first().fill('Flat Name');
    await page.locator('.page').first().click({ position: { x: 20, y: 20 } });
    await panel(page, 'Fill & Sign');
    await page.getByRole('button', { name: /Flatten form fields/ }).click();
    const bytes = (await save(page)).bytes;
    expect((await PDFDocument.load(bytes)).getForm().getFields().length).toBe(0);
    expect((await pdfInfo(bytes)).pages[0]).toContain('Flat Name');
  });
});
