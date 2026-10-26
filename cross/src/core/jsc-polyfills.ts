// The little that pdf-lib, fflate and the writers expect from a browser, for bare JavaScriptCore.
const g = globalThis as unknown as Record<string, unknown>;
g.console ??= { log() {}, warn() {}, error() {}, info() {}, debug() {} };
// No event loop: run "later" work as a microtask, which JavaScriptCore drains before returning to the app.
g.setTimeout ??= (f: () => void) => { Promise.resolve().then(f); return 0; };
g.clearTimeout ??= () => {};
g.queueMicrotask ??= (f: () => void) => { Promise.resolve().then(f); };
if (!g.TextEncoder) {
  g.TextEncoder = class {
    encode(s: string): Uint8Array {
      const out: number[] = [];
      for (const ch of s) {
        const c = ch.codePointAt(0)!;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
  };
}
if (!g.TextDecoder) {
  g.TextDecoder = class {
    decode(b?: Uint8Array): string {
      if (!b) return '';
      let s = '';
      for (let i = 0; i < b.length;) {
        const c = b[i++];
        let cp = c;
        if (c >= 0xf0) cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        else if (c >= 0xe0) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        else if (c >= 0xc0) cp = ((c & 31) << 6) | (b[i++] & 63);
        s += String.fromCodePoint(cp);
      }
      return s;
    }
  };
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
g.btoa ??= (s: string) => {
  let out = '';
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=');
  }
  return out;
};
g.atob ??= (s: string) => {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  let out = '';
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2] ?? 'A') & 63) << 6) | (B64.indexOf(clean[i + 3] ?? 'A') & 63);
    out += String.fromCharCode((n >> 16) & 255);
    if (i + 2 < clean.length) out += String.fromCharCode((n >> 8) & 255);
    if (i + 3 < clean.length) out += String.fromCharCode(n & 255);
  }
  return out;
};
export {};
