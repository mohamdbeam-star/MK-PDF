import { useEffect, useRef, useState } from 'preact/hooks';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { active } from '../app/store';
import { platform } from '../app/platform';
import { openPdfjs } from '../pdf/doc';
import { renderPage } from '../pdf/render';

interface Change { page: number; removed: string; added: string }

async function pageWords(doc: PDFDocumentProxy, page: number): Promise<string[]> {
  if (page >= doc.numPages) return [];
  const tc = await (await doc.getPage(page + 1)).getTextContent();
  return tc.items.map((i) => ('str' in i ? i.str : '')).join(' ').split(/\s+/).filter(Boolean);
}

/** Longest-common-subsequence word diff, grouped into phrases. */
function diff(a: string[], b: string[]): { removed: string; added: string }[] {
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return [{ removed: n ? `${n} words` : '', added: m ? `${m} words (too long to compare word by word)` : '' }];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { removed: string[]; added: string[] }[] = [];
  let cur: { removed: string[]; added: string[] } | null = null;
  let i = 0, j = 0;
  const flush = () => { if (cur && (cur.removed.length || cur.added.length)) out.push(cur); cur = null; };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; }
    else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) { (cur ??= { removed: [], added: [] }).added.push(b[j++]); }
    else { (cur ??= { removed: [], added: [] }).removed.push(a[i++]); }
  }
  flush();
  return out.map((c) => ({ removed: c.removed.join(' '), added: c.added.join(' ') }));
}

export function Compare({ onClose }: { onClose: () => void }) {
  const [docs, setDocs] = useState<[PDFDocumentProxy, PDFDocumentProxy] | null>(null);
  const [names, setNames] = useState<[string, string]>(['', '']);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [page, setPage] = useState(0);
  const [overlay, setOverlay] = useState(false);
  const left = useRef<HTMLDivElement>(null), right = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const a = active.value;
      let first: { name: string; bytes: Uint8Array } | undefined = a ? { name: a.name, bytes: await a.currentBytes() } : undefined;
      if (!first) [first] = await platform.openFiles('application/pdf,.pdf', false);
      if (!first) return onClose();
      const [second] = await platform.openFiles('application/pdf,.pdf', false);
      if (!second) return onClose();
      const da = await openPdfjs(first.bytes), db = await openPdfjs(second.bytes);
      setDocs([da, db]);
      setNames([first.name, second.name]);
      const all: Change[] = [];
      for (let p = 0; p < Math.max(da.numPages, db.numPages); p++) {
        for (const c of diff(await pageWords(da, p), await pageWords(db, p))) all.push({ page: p, ...c });
      }
      setChanges(all);
    })();
  }, []);

  useEffect(() => {
    if (!docs) return;
    void (async () => {
      const [a, b] = docs;
      const draw = async (d: PDFDocumentProxy) => (page < d.numPages ? renderPage(d, page, 1.4) : null);
      const [ca, cb] = [await draw(a), await draw(b)];
      if (overlay) {
        const w = Math.max(ca?.width ?? 0, cb?.width ?? 0), h = Math.max(ca?.height ?? 0, cb?.height ?? 0);
        const out = document.createElement('canvas');
        out.width = w; out.height = h;
        const ctx = out.getContext('2d')!;
        const pixels = (c: HTMLCanvasElement | null) => {
          const t = document.createElement('canvas'); t.width = w; t.height = h;
          const x = t.getContext('2d')!; x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); if (c) x.drawImage(c, 0, 0);
          return x.getImageData(0, 0, w, h).data;
        };
        const pa = pixels(ca), pb = pixels(cb);
        const img = ctx.createImageData(w, h);
        for (let i = 0; i < w * h * 4; i += 4) {
          const inkA = pa[i] + pa[i + 1] + pa[i + 2] < 600, inkB = pb[i] + pb[i + 1] + pb[i + 2] < 600;
          const [r, g, bl] = inkA && inkB ? [60, 60, 60] : inkA ? [230, 40, 40] : inkB ? [30, 110, 240] : [255, 255, 255];
          img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = bl; img.data[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        left.current!.replaceChildren(out);
        right.current?.replaceChildren();
      } else {
        left.current!.replaceChildren(...(ca ? [ca] : []));
        right.current?.replaceChildren(...(cb ? [cb] : []));
      }
    })();
  }, [docs, page, overlay]);

  const pages = docs ? Math.max(docs[0].numPages, docs[1].numPages) : 0;
  return (
    <div class="compare">
      <header class="glass compare-bar">
        <b>Compare</b><span class="muted">{names[0]} ↔ {names[1]}</span>
        <div class="segmented"><button class={!overlay ? 'on' : ''} onClick={() => setOverlay(false)}>Side by side</button><button class={overlay ? 'on' : ''} onClick={() => setOverlay(true)}>Overlay</button></div>
        <button class="glass-btn" disabled={page <= 0} onClick={() => setPage(page - 1)}>‹</button>
        <span>Page {page + 1} / {pages || '…'}</span>
        <button class="glass-btn" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>›</button>
        <button class="glass-btn" onClick={onClose}>Done</button>
      </header>
      <div class="compare-body">
        <aside class="compare-list glass">
          {!changes && <p class="muted">Comparing…</p>}
          {changes && !changes.length && <p class="muted">No text differences.</p>}
          {changes?.map((c, i) => (
            <button key={i} class={`change ${c.page === page ? 'here' : ''}`} onClick={() => setPage(c.page)}>
              <small>Page {c.page + 1}</small>
              {c.removed && <del>{c.removed}</del>}
              {c.added && <ins>{c.added}</ins>}
            </button>
          ))}
        </aside>
        <div class="compare-pages">
          <div ref={left} class="compare-page" />
          {!overlay && <div ref={right} class="compare-page" />}
        </div>
      </div>
      {overlay && <p class="compare-legend muted">Red: only in the original · Blue: only in the revised file</p>}
    </div>
  );
}
