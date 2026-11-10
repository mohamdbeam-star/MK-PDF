// Superscript and subscript as Unicode characters (m², H₂O, xⁿ): they stay what they mean when the text is
// searched, copied or exported, and every bundled font draws them. Only digits, signs and some letters have them.
const NORMAL = '0123456789+-=()';
const SUPER_SIGNS = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾';
const SUB_SIGNS = '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎';
const SUPER_LETTERS: Record<string, string> = {
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ',
  r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
};
const SUB_LETTERS: Record<string, string> = {
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};
const table = (signs: string, letters: Record<string, string>) =>
  new Map<string, string>([...[...NORMAL].map((c, i) => [c, [...signs][i]] as [string, string]), ...Object.entries(letters)]);
const SUPER = table(SUPER_SIGNS, SUPER_LETTERS), SUB = table(SUB_SIGNS, SUB_LETTERS);
const BACK = new Map<string, string>([...SUPER, ...SUB].map(([a, b]) => [b, a]));

/**
 * The text raised or lowered, or back to normal when it already is. Null when a character has no such form
 * (capital letters, most punctuation); spaces stay as they are.
 */
export function shiftScript(text: string, kind: 'super' | 'sub'): string | null {
  const map = kind === 'super' ? SUPER : SUB;
  const chars = [...text];
  const already = chars.every((c) => /\s/.test(c) || [...map.values()].includes(c));
  if (already) return chars.map((c) => BACK.get(c) ?? c).join('');
  const out = chars.map((c) => (/\s/.test(c) ? c : map.get(c) ?? null));
  return out.every((c) => c !== null) ? out.join('') : null;
}
