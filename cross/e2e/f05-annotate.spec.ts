import { test, expect, openDoc, save, pdfInfo, dragOnPage, clickOnPage, answer, tool, panel } from './helpers';

test.describe('F05 comment and mark up', () => {
  test('F05-H1 sticky note, text box, rectangle and drawing all save as annotations', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await tool(page, 'Sticky Note');
    await clickOnPage(page, 0, [0.7, 0.3]);
    await answer(page, 'Check this number');
    await tool(page, 'Add Text');
    await clickOnPage(page, 0, [0.2, 0.5]);
    await answer(page, 'Approved ✓ é');
    await panel(page, 'Comment');
    await tool(page, 'Rectangle');
    await dragOnPage(page, 0, [0.1, 0.6], [0.4, 0.7]);
    await tool(page, 'Draw');
    await dragOnPage(page, 0, [0.5, 0.6], [0.8, 0.75]);
    const info = await pdfInfo((await save(page)).bytes);
    expect(info.annots[0].sort()).toEqual(['FreeText', 'Ink', 'Square', 'Text'].sort());
    expect(info.annots[1]).toEqual([]);
  });

  test('F05-H2 highlight selected text', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await tool(page, 'Highlight');
    const word = page.locator('.page').first().locator('.textLayer span', { hasText: 'quick brown fox' }).first();
    const b = (await word.boundingBox())!;
    await page.mouse.move(b.x + 1, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    const info = await pdfInfo((await save(page)).bytes);
    expect(info.annots[0]).toContain('Highlight');
  });

  test('F05-N1 cancelling the sticky note prompt adds nothing', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await tool(page, 'Sticky Note');
    await clickOnPage(page, 0, [0.7, 0.3]);
    await page.locator('.sheet').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled();
  });

  test('F05-H3 select a note and delete it with the Delete key, then undo', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await tool(page, 'Sticky Note');
    await clickOnPage(page, 0, [0.7, 0.3]);
    await answer(page, 'to delete');
    await page.locator('.mk-hit').first().click();
    await page.keyboard.press('Delete');
    expect((await pdfInfo((await save(page)).bytes)).annots[0]).toEqual([]);
    await page.keyboard.press('ControlOrMeta+z');
    expect((await pdfInfo((await save(page)).bytes)).annots[0]).toEqual(['Text']);
  });

  test('F05-E1 a tiny accidental rectangle drag adds nothing', async ({ page, errors }) => {
    await openDoc(page, 'report.pdf', 3);
    await panel(page, 'Comment');
    await tool(page, 'Rectangle');
    await dragOnPage(page, 0, [0.3, 0.3], [0.301, 0.301], 1);
    await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled();
  });
});
