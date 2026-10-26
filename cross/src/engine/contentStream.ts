// PDF content-stream tokenizer, parser and serializer. Unchanged operations keep their original bytes.

export type PDFValue =
  | { t: 'num'; v: number }
  | { t: 'str'; v: Uint8Array }
  | { t: 'name'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'arr'; v: PDFValue[] }
  | { t: 'dict'; v: [string, PDFValue][] };

export interface Op {
  op: string;
  operands: PDFValue[];
  /** Original bytes (operands + operator); absent when the operation was created or changed. */
  source?: Uint8Array;
}

export const num = (v: number): PDFValue => ({ t: 'num', v });
export const str = (v: Uint8Array): PDFValue => ({ t: 'str', v });
export const nameV = (v: string): PDFValue => ({ t: 'name', v });
export const op = (o: string, operands: PDFValue[] = []): Op => ({ op: o, operands });

export function formatNumber(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  let s = n.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

function escapeName(n: string): string {
  let out = '';
  for (const b of new TextEncoder().encode(n)) {
    out += b < 33 || b > 126 || '()<>[]{}/%#'.includes(String.fromCharCode(b)) ? '#' + b.toString(16).padStart(2, '0').toUpperCase() : String.fromCharCode(b);
  }
  return out;
}

export function serializeValue(v: PDFValue): string {
  switch (v.t) {
    case 'num': return formatNumber(v.v);
    case 'str': return '<' + Array.from(v.v, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase() + '>';
    case 'name': return '/' + escapeName(v.v);
    case 'bool': return v.v ? 'true' : 'false';
    case 'null': return 'null';
    case 'arr': return '[' + v.v.map(serializeValue).join(' ') + ']';
    case 'dict': return '<<' + v.v.map(([k, x]) => '/' + escapeName(k) + ' ' + serializeValue(x)).join(' ') + '>>';
  }
}

const enc = new TextEncoder();

export function serializeOp(o: Op): Uint8Array {
  if (o.source) return o.source;
  return enc.encode([...o.operands.map(serializeValue), o.op].join(' '));
}

export function serialize(ops: Op[]): Uint8Array {
  const parts = ops.map(serializeOp);
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; out[i++] = 10; }
  return out;
}

const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set(Array.from('()<>[]{}/%', (c) => c.charCodeAt(0)));

type Token =
  | { k: 'value'; v: PDFValue }
  | { k: 'arrStart' } | { k: 'arrEnd' } | { k: 'dictStart' } | { k: 'dictEnd' }
  | { k: 'kw'; v: string };

function hexValue(b: number): number {
  if (b >= 48 && b <= 57) return b - 48;
  if (b >= 65 && b <= 70) return b - 55;
  if (b >= 97 && b <= 102) return b - 87;
  return -1;
}

class Parser {
  i = 0;
  constructor(private bytes: Uint8Array) {}

  skipWhite() {
    const b = this.bytes;
    while (this.i < b.length) {
      if (WHITE.has(b[this.i])) this.i++;
      else if (b[this.i] === 37) { while (this.i < b.length && b[this.i] !== 10 && b[this.i] !== 13) this.i++; }
      else break;
    }
  }

  token(): Token | null {
    const b = this.bytes;
    for (;;) {
      this.skipWhite();
      if (this.i >= b.length) return null;
      const c = b[this.i];
      if (c === 91) { this.i++; return { k: 'arrStart' }; }
      if (c === 93) { this.i++; return { k: 'arrEnd' }; }
      if (c === 123 || c === 125) { this.i++; return { k: 'kw', v: String.fromCharCode(c) }; }
      if (c === 60) {
        if (b[this.i + 1] === 60) { this.i += 2; return { k: 'dictStart' }; }
        return { k: 'value', v: { t: 'str', v: this.hex() } };
      }
      if (c === 62) {
        if (b[this.i + 1] === 62) { this.i += 2; return { k: 'dictEnd' }; }
        this.i++; continue;
      }
      if (c === 40) return { k: 'value', v: { t: 'str', v: this.literal() } };
      if (c === 47) return { k: 'value', v: { t: 'name', v: this.name() } };
      if (c === 41) { this.i++; continue; }
      const start = this.i;
      while (this.i < b.length && !WHITE.has(b[this.i]) && !DELIM.has(b[this.i])) this.i++;
      if (this.i === start) { this.i++; continue; }
      const word = new TextDecoder('latin1').decode(b.subarray(start, this.i));
      const f = word[0];
      if (f === '+' || f === '-' || f === '.' || (f >= '0' && f <= '9')) {
        let n = Number(word);
        if (Number.isNaN(n)) { n = Number(word.replace(/^[+-]+/, '')); if (word.startsWith('-')) n = -n; if (Number.isNaN(n)) n = 0; }
        return { k: 'value', v: { t: 'num', v: n } };
      }
      if (word === 'true') return { k: 'value', v: { t: 'bool', v: true } };
      if (word === 'false') return { k: 'value', v: { t: 'bool', v: false } };
      if (word === 'null') return { k: 'value', v: { t: 'null' } };
      return { k: 'kw', v: word };
    }
  }

  hex(): Uint8Array {
    const b = this.bytes, out: number[] = [];
    this.i++;
    let high = -1;
    while (this.i < b.length && b[this.i] !== 62) {
      const v = hexValue(b[this.i]);
      if (v >= 0) { if (high >= 0) { out.push((high << 4) | v); high = -1; } else high = v; }
      this.i++;
    }
    if (high >= 0) out.push(high << 4);
    this.i++;
    return Uint8Array.from(out);
  }

  literal(): Uint8Array {
    const b = this.bytes, out: number[] = [];
    this.i++;
    let depth = 1;
    while (this.i < b.length) {
      const c = b[this.i];
      if (c === 92) {
        this.i++;
        const e = b[this.i];
        if (e === undefined) break;
        if (e === 110) out.push(10); else if (e === 114) out.push(13); else if (e === 116) out.push(9);
        else if (e === 98) out.push(8); else if (e === 102) out.push(12);
        else if (e === 13) { if (b[this.i + 1] === 10) this.i++; }
        else if (e === 10) { /* line continuation */ }
        else if (e >= 48 && e <= 55) {
          let v = e - 48, n = 1;
          while (n < 3 && b[this.i + 1] >= 48 && b[this.i + 1] <= 55) { this.i++; v = v * 8 + b[this.i] - 48; n++; }
          out.push(v & 0xff);
        } else out.push(e);
        this.i++;
        continue;
      }
      if (c === 40) depth++;
      if (c === 41 && --depth === 0) { this.i++; break; }
      out.push(c);
      this.i++;
    }
    return Uint8Array.from(out);
  }

  name(): string {
    const b = this.bytes, out: number[] = [];
    this.i++;
    while (this.i < b.length && !WHITE.has(b[this.i]) && !DELIM.has(b[this.i])) {
      if (b[this.i] === 35 && hexValue(b[this.i + 1]) >= 0 && hexValue(b[this.i + 2]) >= 0) {
        out.push((hexValue(b[this.i + 1]) << 4) | hexValue(b[this.i + 2]));
        this.i += 3;
      } else out.push(b[this.i++]);
    }
    return new TextDecoder().decode(Uint8Array.from(out));
  }

  value(first: Token): PDFValue | null {
    if (first.k === 'value') return first.v;
    if (first.k === 'arrStart') {
      const items: PDFValue[] = [];
      for (let t = this.token(); t && t.k !== 'arrEnd'; t = this.token()) { const v = this.value(t); if (v) items.push(v); }
      return { t: 'arr', v: items };
    }
    if (first.k === 'dictStart') {
      const items: [string, PDFValue][] = [];
      let key: string | null = null;
      for (let t = this.token(); t && t.k !== 'dictEnd'; t = this.token()) {
        const v = this.value(t);
        if (!v) continue;
        if (key !== null) { items.push([key, v]); key = null; } else if (v.t === 'name') key = v.v;
      }
      return { t: 'dict', v: items };
    }
    return null;
  }

  operations(): Op[] {
    const ops: Op[] = [];
    let operands: PDFValue[] = [];
    this.skipWhite();
    let start = this.i;
    for (let t = this.token(); t; t = this.token()) {
      if (t.k === 'kw') {
        if (t.v === 'BI') ops.push({ op: 'BI', operands: [], source: this.inlineImage(start) });
        else ops.push({ op: t.v, operands, source: this.bytes.slice(start, this.i) });
        operands = [];
        this.skipWhite();
        start = this.i;
      } else if (t.k !== 'arrEnd' && t.k !== 'dictEnd') {
        const v = this.value(t);
        if (v) operands.push(v);
      }
    }
    return ops;
  }

  inlineImage(start: number): Uint8Array {
    const b = this.bytes;
    for (let t = this.token(); t; t = this.token()) if (t.k === 'kw' && t.v === 'ID') break;
    this.i++;
    while (this.i + 1 < b.length) {
      if (b[this.i] === 69 && b[this.i + 1] === 73 && WHITE.has(b[this.i - 1]) &&
          (this.i + 2 >= b.length || WHITE.has(b[this.i + 2]) || DELIM.has(b[this.i + 2]))) { this.i += 2; break; }
      this.i++;
    }
    if (this.i >= b.length - 1) this.i = b.length;
    return b.slice(start, this.i);
  }
}

export function parse(bytes: Uint8Array): Op[] {
  return new Parser(bytes).operations();
}
