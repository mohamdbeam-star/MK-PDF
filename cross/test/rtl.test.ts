// Right-to-left text that pdf.js leaves in drawing order (one letter per item, left to right on the page).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textIn, visualToLogical } from '../src/engine/layout';

test('visual Arabic is read right to left, numbers and Latin words keep their order', () => {
  // "رقم 2026" drawn left to right is "2026 مقر"; "اسم Projection House" is "Projection House مسا".
  assert.equal(visualToLogical('2026 مقر'), 'رقم 2026');
  assert.equal(visualToLogical('Projection House مسا'), 'اسم Projection House');
  // Brackets look the same either way round on the page; in reading order they swap.
  assert.equal(visualToLogical('(مسا)'), '(اسم)');
});

test('one-letter right-to-left items in positional shapes become a word in reading order', () => {
  // "الهند" as drawn: د ن ه ل ا from left to right, each its own item, in positional forms.
  const letters = ['ﺪ', 'ﻨ', 'ﻬ', 'ﻟ', 'ا'];
  const items = letters.map((str, i) => ({ str, x: 100 + i * 4, y: 500, w: 4, h: 10, rtl: true }));
  // A misplaced space item (as some PDFs draw them) must not split the word.
  items.push({ str: ' ', x: 103, y: 500, w: 30, h: 10, rtl: false });
  assert.equal(textIn(items, { x: 99, y: 498, w: 30, h: 10 }), 'الهند');
});
