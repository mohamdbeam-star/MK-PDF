// Reading view: the document reflowed into one column for small screens. Headings, paragraphs, lists and tables
// come from the page layout; repeated page furniture (running titles, page numbers) is left out; the headings make a
// contents list. Text size and line spacing are the reader's own and are remembered.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DocModel } from '../pdf/doc';
import type { LayoutRun, PageLayout } from '../engine/layout';
import { lineSize, lineText, paragraphRuns, paragraphText } from '../engine/layout';
import { nightMode, readingView } from '../app/store';
import { Icon } from './icons';

type Block =
  | { kind: 'h'; level: 1 | 2 | 3; text: string; id: string }
  | { kind: 'p'; runs: LayoutRun[]; rtl: boolean; align: string }
  | { kind: 'li'; runs: LayoutRun[]; rtl: boolean }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'scan'; page: number }
  | { kind: 'page'; page: number };

const BULLET = /^\s*[•●▪◦‣∙–-]\s*/;
const stored = (key: string, fallback: number) => { try { const v = Number(localStorage.getItem(key)); return v > 0 ? v : fallback; } catch { return fallback; } };
const keep = (key: string, v: number) => { try { localStorage.setItem(key, String(v)); } catch { /* not kept */ } };

export function readingBlocks(pages: PageLayout[]): Block[] {
  const sizes = pages.flatMap((l) => l.items.flatMap((i) => (i.kind === 'paragraph' ? [lineSize(i.lines[0])] : []))).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] ?? 12;
  // Furniture: text near the top or bottom edge that repeats (numbers aside) on another page.
  const edgeKey = (l: PageLayout, t: string, y: number) => ((y > l.crop.y + l.crop.h * 0.9 || y < l.crop.y + l.crop.h * 0.1) ? t.replace(/\d+/g, '#').trim() : null);
  const seen = new Map<string, Set<number>>();
  for (const l of pages) for (const i of l.items) if (i.kind === 'paragraph') {
    const k = edgeKey(l, paragraphText(i), i.rect.y + i.rect.h / 2);
    if (k) seen.set(k, (seen.get(k) ?? new Set()).add(l.index));
  }
  const furniture = (l: PageLayout, t: string, y: number) => { const k = edgeKey(l, t, y); return !!k && (seen.get(k)?.size ?? 0) > 1; };
  const out: Block[] = [];
  let n = 0;
  for (const l of pages) {
    if (pages.length > 1) out.push({ kind: 'page', page: l.index });
    const text = l.items.some((i) => i.kind === 'paragraph' && paragraphText(i).trim());
    // A page that is only a picture (a scan before recognition) has nothing to reflow.
    if (!text && l.items.some((i) => i.kind === 'image')) { out.push({ kind: 'scan', page: l.index }); continue; }
    for (const i of l.items) {
      if (i.kind === 'paragraph') {
        const t = paragraphText(i).replace(/\s*\n\s*/g, ' ').trim();
        if (!t || furniture(l, t, i.rect.y + i.rect.h / 2)) continue;
        const size = lineSize(i.lines[0]), runs = paragraphRuns(i).map((r) => ({ ...r, text: r.text.replace(/\n/g, ' ') }));
        const level = size >= body * 1.6 ? 1 : size >= body * 1.25 ? 2 : size >= body * 1.1 && runs.every((r) => r.font.bold) && t.length < 120 ? 3 : 0;
        if (level) out.push({ kind: 'h', level: level as 1 | 2 | 3, text: t, id: `h${++n}` });
        else if (BULLET.test(t)) out.push({ kind: 'li', runs: stripBullet(runs), rtl: i.rtl });
        else out.push({ kind: 'p', runs, rtl: i.rtl, align: i.alignment === 'center' ? 'center' : 'start' });
      } else if (i.kind === 'table') {
        out.push({ kind: 'table', rows: i.rows.map((r) => r.map((c) => (c ? lineText(c) : ''))) });
      }
    }
  }
  return out;
}

function stripBullet(runs: LayoutRun[]): LayoutRun[] {
  const [first, ...rest] = runs;
  return first ? [{ ...first, text: first.text.replace(BULLET, '') }, ...rest] : runs;
}

const Runs = ({ runs }: { runs: LayoutRun[] }) => (
  <>{runs.map((r, k) => { let el: preact.ComponentChildren = r.text; if (r.font.italic) el = <em>{el}</em>; if (r.font.bold) el = <strong>{el}</strong>; return <span key={k}>{el}</span>; })}</>
);

export function ReadingView({ doc }: { doc: DocModel }) {
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [failed, setFailed] = useState('');
  const [size, setSize] = useState(() => stored('mkpdf.readSize', 18));
  const [spacing, setSpacing] = useState(() => stored('mkpdf.readSpacing', 1.6));
  const [contents, setContents] = useState(false);
  const article = useRef<HTMLDivElement>(null);
  const v = doc.version.value;
  useEffect(() => {
    let alive = true;
    setBlocks(null);
    void (async () => {
      const { layouts } = await import('../pdf/exporter');
      const { pages } = await layouts(await doc.currentBytes(), doc.js!);
      if (alive) setBlocks(readingBlocks(pages));
    })().catch((e) => alive && setFailed((e as Error).message));
    return () => { alive = false; };
  }, [doc, v]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') readingView.value = false; };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const resize = (d: number) => { const s = Math.min(32, Math.max(12, size + d)); setSize(s); keep('mkpdf.readSize', s); };
  const space = () => { const s = spacing >= 1.9 ? 1.3 : Math.round((spacing + 0.3) * 10) / 10; setSpacing(s); keep('mkpdf.readSpacing', s); };
  const headings = (blocks ?? []).filter((b): b is Extract<Block, { kind: 'h' }> => b.kind === 'h');
  const go = (id: string) => { setContents(false); article.current?.querySelector(`#${id}`)?.scrollIntoView({ block: 'start' }); };
  return (
    <div class={`reader ${nightMode.value ? 'night' : ''}`} role="dialog" aria-label="Reading view">
      <header class="reader-bar">
        <button class="icon-btn" title="Close reading view" onClick={() => (readingView.value = false)}><Icon name="x" /></button>
        <b class="reader-title">{doc.name}</b>
        {headings.length > 0 && <button class={`icon-btn ${contents ? 'on' : ''}`} title="Contents" aria-expanded={contents} onClick={() => setContents(!contents)}><Icon name="contents" /></button>}
        <button class="icon-btn" title="Smaller text" aria-label="Smaller text" onClick={() => resize(-2)}>A−</button>
        <button class="icon-btn" title="Larger text" aria-label="Larger text" onClick={() => resize(2)}>A+</button>
        <button class="icon-btn" title={`Line spacing ${spacing}`} onClick={space}><Icon name="lines" /></button>
      </header>
      {contents && <nav class="reader-contents" aria-label="Contents">
        {headings.map((h) => <button key={h.id} class={`toc-${h.level}`} onClick={() => go(h.id)}>{h.text}</button>)}
      </nav>}
      <div class="reader-scroll" ref={article}>
        <article class="reader-text" style={{ fontSize: `${size}px`, lineHeight: String(spacing) }}>
          {failed && <p class="muted">Couldn't reflow this document: {failed}</p>}
          {!blocks && !failed && <p class="muted">Preparing the reading view…</p>}
          {blocks?.map((b, k) => {
            switch (b.kind) {
              case 'h': { const H = `h${b.level + 1}` as 'h2'; return <H key={k} id={b.id}>{b.text}</H>; }
              case 'p': return <p key={k} dir={b.rtl ? 'rtl' : 'auto'} style={{ textAlign: b.align }}><Runs runs={b.runs} /></p>;
              case 'li': return <ul key={k} dir={b.rtl ? 'rtl' : 'auto'}><li><Runs runs={b.runs} /></li></ul>;
              case 'table': return <div key={k} class="reader-table"><table><tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}</tr>)}</tbody></table></div>;
              case 'scan': return <p key={k} class="muted reader-note">Page {b.page + 1} is a scanned image. Recognize its text (Scan &amp; OCR) to read it here.</p>;
              case 'page': return <div key={k} class="reader-page" aria-hidden="true">{b.page + 1}</div>;
            }
          })}
        </article>
      </div>
    </div>
  );
}
