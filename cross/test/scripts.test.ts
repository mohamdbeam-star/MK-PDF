import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftScript } from '../src/pdf/scripts';

test('digits, signs and lower-case letters raise and lower', () => {
  assert.equal(shiftScript('2', 'super'), '²');
  assert.equal(shiftScript('2', 'sub'), '₂');
  assert.equal(shiftScript('-1', 'super'), '⁻¹');
  assert.equal(shiftScript('n+1', 'super'), 'ⁿ⁺¹');
  assert.equal(shiftScript('x', 'sub'), 'ₓ');
});

test('pressing again puts the text back', () => {
  assert.equal(shiftScript('²', 'super'), '2');
  assert.equal(shiftScript('₂', 'sub'), '2');
  assert.equal(shiftScript('ⁿ⁺¹', 'super'), 'n+1');
});

test('characters without a raised or lowered form are refused', () => {
  assert.equal(shiftScript('TM', 'super'), null);
  assert.equal(shiftScript('b', 'sub'), null);
  assert.equal(shiftScript('2!', 'super'), null);
});
