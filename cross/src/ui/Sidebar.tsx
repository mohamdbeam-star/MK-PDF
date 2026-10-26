import { useEffect, useRef, useState } from 'preact/hooks';
import type { DocModel } from '../pdf/doc';
import { pageIndex, search, searchResults, selectedAnnot, sidebarMode } from '../app/store';
import { edit, goTo } from '../app/actions';
import * as annots from '../pdf/annots';
import * as ops from '../pdf/ops';
import { renderPage } from '../pdf/render';
import { readDoc } from './Overlay';
import { Icon } from './icons';

const thumbs = new WeakMap<DocModel, Map<string, Promise<string>>>();
export function thumbnail(doc: DocModel, index: number, width: number): Promise<string> {
  let m = thumbs.get(doc);
  if (!m) { m = new Map(); thumbs.set(doc, m); }
  const key = `${doc.version.peek()}:${index}:${width}`;
  if (!m.has(key)) m.set(key, (async () => {
    const page = await doc.js!.getPage(index + 1);
    const vp = page.getViewport({ scale: 1 });
    const c = await renderPage(doc.js!, index, (width * 2) / vp.width);
    return c.toDataURL('image/jpeg', 0.8);
  })());
  return m.get(key)!;
}

export function Thumb({ doc, index, width }: { doc: DocModel; index: number; width: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const v = doc.version.value;
  useEffect(() => {
    let alive = true;
    const io = new IntersectionObserver((e) => {
      if (!e[0].isIntersecting) return;
      io.disconnect();
      void thumbnail(doc, index, width).then((s) => alive && setSrc(s));
    }, { rootMargin: '300px' });
    io.observe(ref.current!);
    return () => { alive = false; io.disconnect(); };
  }, [doc, index, width, v]);
  return <div ref={ref} class="thumb" style={{ width: `${width}px` }}>{src ? <img src={src} alt={`Page ${index + 1}`} /> : <div class="thumb-blank" />}</div>;
}

function Thumbnails({ doc }: { doc: DocModel }) {
  const n = doc.js?.numPages ?? 0;
  const [dragging, setDragging] = useState<number | null>(null);
  return (
    <div class="thumbs">
      {[...Array(n).keys()].map((i) => (
        <button key={i} class={`thumb-item ${pageIndex.value === i ? 'on' : ''}`} onClick={() => goTo(i)} draggable
          onDragStart={() => setDragging(i)} onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragging === null || dragging === i) return;
            const order = [...Array(n).keys()];
            order.splice(i, 0, ...order.splice(dragging, 1));
            setDragging(null);
            void edit('Move Page', (d) => ops.reorder(d, order));
          }}>
          <Thumb doc={doc} index={i} width={110} />
          <span>{i + 1}</span>
        </button>
      ))}
    </div>
  );
}

interface OutlineItem { title: string; dest: unknown; items: OutlineItem[] }

function Outline({ doc }: { doc: DocModel }) {
  const [items, setItems] = useState<OutlineItem[] | null>(null);
  useEffect(() => { void doc.js?.getOutline().then((o) => setItems((o as OutlineItem[] | null) ?? [])); }, [doc, doc.version.value]);
  const go = async (dest: unknown) => {
    const d = typeof dest === 'string' ? await doc.js!.getDestination(dest) : dest as unknown[];
    if (!d) return;
    const index = await doc.js!.getPageIndex(d[0] as never);
    goTo(index);
  };
  const tree = (list: OutlineItem[], depth = 0): preact.JSX.Element[] => list.flatMap((it, k) => [
    <button key={`${depth}-${k}`} class="outline-item" style={{ paddingLeft: `${10 + depth * 14}px` }} onClick={() => go(it.dest)}>{it.title}</button>,
    ...tree(it.items ?? [], depth + 1),
  ]);
  if (!items) return <p class="muted pad">Loading…</p>;
  if (!items.length) return <p class="muted pad">This document has no bookmarks.</p>;
  return <div class="outline">{tree(items)}</div>;
}

function Comments({ doc }: { doc: DocModel }) {
  const [list, setList] = useState<annots.AnnotInfo[]>([]);
  const [filter, setFilter] = useState('');
  useEffect(() => { void readDoc(doc).then((d) => setList(annots.listAnnots(d).filter(annots.isComment))); }, [doc, doc.version.value]);
  const shown = list.filter((a) => !filter || `${a.subtype} ${a.contents}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div class="comments">
      <input class="field" placeholder="Filter comments" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
      {!shown.length && <p class="muted pad">Highlights, notes and drawings appear here.</p>}
      {shown.map((a) => (
        <button key={`${a.page}:${a.index}`} class="comment" onClick={() => { goTo(a.page); selectedAnnot.value = a; }}>
          <b>{a.subtype === 'Text' ? 'Note' : a.subtype === 'FreeText' ? 'Text box' : a.subtype}</b><small>p. {a.page + 1}</small>
          {a.contents && <span>{a.contents}</span>}
          {a.author && <small class="muted">{a.author}</small>}
        </button>
      ))}
    </div>
  );
}

function SearchList() {
  return (
    <div class="search">
      <input class="field" placeholder="Search" value={search.value} onInput={(e) => (search.value = (e.target as HTMLInputElement).value)} />
      {search.value && <p class="muted pad">{searchResults.value.length} results</p>}
      {searchResults.value.map((r) => (
        <button key={`${r.page}:${r.index}`} class="comment" onClick={() => goTo(r.page)}>
          <small>Page {r.page + 1}</small><span>{r.text}</span>
        </button>
      ))}
    </div>
  );
}

export function Sidebar({ doc }: { doc: DocModel }) {
  const m = sidebarMode.value;
  return (
    <aside class="sidebar glass">
      <div class="segmented">
        {([['thumbs', 'grid'], ['outline', 'bookmark'], ['comments', 'comment'], ['search', 'search']] as const).map(([k, icon]) => (
          <button key={k} class={m === k ? 'on' : ''} title={k} onClick={() => (sidebarMode.value = k)}><Icon name={icon} size={16} /></button>
        ))}
      </div>
      {m === 'thumbs' && <Thumbnails doc={doc} />}
      {m === 'outline' && <Outline doc={doc} />}
      {m === 'comments' && <Comments doc={doc} />}
      {m === 'search' && <SearchList />}
    </aside>
  );
}
