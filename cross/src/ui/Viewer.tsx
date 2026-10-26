import { useEffect, useRef } from 'preact/hooks';
import { render } from 'preact';
import { AnnotationMode } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import 'pdfjs-dist/legacy/web/pdf_viewer.css';
import type { DocModel } from '../pdf/doc';
import { pageIndex, scale, search, searchResults, tool } from '../app/store';
import { edit } from '../app/actions';
import * as annots from '../pdf/annots';
import { PageOverlay } from './Overlay';

export interface ViewerApi { viewer: PDFViewer; find: PDFFindController; bus: EventBus }
export const viewerApi: { current: ViewerApi | null } = { current: null };

const MARKUP = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut' } as const;

export function Viewer({ doc }: { doc: DocModel }) {
  const container = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const api = useRef<ViewerApi | null>(null);
  const restore = useRef<{ scale: string | number; top: number; left: number } | null>(null);
  const version = doc.version.value;

  useEffect(() => {
    const bus = new EventBus();
    const link = new PDFLinkService({ eventBus: bus });
    const find = new PDFFindController({ eventBus: bus, linkService: link });
    const viewer = new PDFViewer({
      container: container.current!, viewer: inner.current!, eventBus: bus, linkService: link, findController: find,
      annotationMode: AnnotationMode.ENABLE_FORMS, textLayerMode: 1, removePageBorders: false, maxCanvasPixels: 16_777_216,
    } as never);
    link.setViewer(viewer);
    api.current = { viewer, find, bus };
    viewerApi.current = api.current;
    bus.on('pagesinit', () => {
      const r = restore.current;
      if (r) viewer.currentScale = r.scale as number; else viewer.currentScaleValue = window.innerWidth < 700 ? 'page-width' : 'auto';
      if (r) requestAnimationFrame(() => { container.current!.scrollTop = r.top; container.current!.scrollLeft = r.left; });
    });
    bus.on('pagechanging', (e: { pageNumber: number }) => (pageIndex.value = e.pageNumber - 1));
    bus.on('scalechanging', (e: { scale: number }) => (scale.value = e.scale));
    const attach = (e: { pageNumber: number; source: { div: HTMLDivElement; viewport: unknown } }) => {
      const pv = e.source;
      let host = pv.div.querySelector<HTMLDivElement>(':scope > .mk-overlay');
      if (!host) { host = document.createElement('div'); host.className = 'mk-overlay'; pv.div.appendChild(host); }
      render(<PageOverlay doc={doc} page={e.pageNumber - 1} viewport={pv.viewport as never} />, host);
    };
    bus.on('pagerendered', attach);
    bus.on('annotationlayerrendered', attach as never);
    bus.on('updatefindmatchescount', () => collectResults(find));
    const goto = (e: Event) => viewer.scrollPageIntoView({ pageNumber: (e as CustomEvent).detail + 1 });
    window.addEventListener('mkpdf-goto', goto);
    return () => { window.removeEventListener('mkpdf-goto', goto); viewer.setDocument(null as never); viewerApi.current = null; };
  }, [doc]);

  useEffect(() => {
    const a = api.current;
    if (!a || !doc.js) return;
    const c = container.current!;
    restore.current = a.viewer.pdfDocument ? { scale: a.viewer.currentScale, top: c.scrollTop, left: c.scrollLeft } : null;
    a.viewer.setDocument(doc.js);
    (a.viewer as unknown as { linkService: PDFLinkService }).linkService.setDocument(doc.js);
  }, [doc, version]);

  // Highlight / underline / strikethrough the text selection when the mouse is released.
  useEffect(() => {
    const onUp = async () => {
      const t = tool.value as keyof typeof MARKUP;
      if (!(t in MARKUP)) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !api.current) return;
      const byPage = new Map<number, { x: number; y: number; w: number; h: number }[]>();
      for (let r = 0; r < sel.rangeCount; r++) {
        for (const rect of sel.getRangeAt(r).getClientRects()) {
          if (rect.width < 1 || rect.height < 1) continue;
          for (let p = 0; p < api.current.viewer.pagesCount; p++) {
            const pv = api.current.viewer.getPageView(p) as unknown as { div: HTMLDivElement; viewport: { convertToPdfPoint(x: number, y: number): number[] } };
            const box = pv?.div?.getBoundingClientRect();
            if (!box || rect.top < box.top || rect.bottom > box.bottom + 2) continue;
            const [x0, y0] = pv.viewport.convertToPdfPoint(rect.left - box.left, rect.bottom - box.top);
            const [x1, y1] = pv.viewport.convertToPdfPoint(rect.right - box.left, rect.top - box.top);
            byPage.set(p, [...(byPage.get(p) ?? []), { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }]);
          }
        }
      }
      sel.removeAllRanges();
      if (!byPage.size) return;
      const { color } = await import('../app/store');
      await edit(t === 'highlight' ? 'Highlight' : t === 'underline' ? 'Underline' : 'Strikethrough', (d) => {
        for (const [p, rects] of byPage) annots.addMarkup(d, p, mergeLines(rects), MARKUP[t], t === 'highlight' ? color.value : color.value.map((c) => c * 0.8) as never);
      });
    };
    document.addEventListener('pointerup', onUp);
    return () => document.removeEventListener('pointerup', onUp);
  }, []);

  // Search box drives pdf.js's find controller.
  const q = search.value;
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    if (!q.trim()) { searchResults.value = []; a.bus.dispatch('findbarclose', { source: null }); return; }
    a.bus.dispatch('find', { source: null, type: '', query: q, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false });
  }, [q, version]);

  const hand = tool.value === 'hand';
  return (
    <div ref={container} class={`viewer-container ${hand ? 'hand' : ''}`} data-tool={tool.value}
      onPointerDown={hand ? (e) => startPan(e, container.current!) : undefined}>
      <div ref={inner} class="pdfViewer" />
    </div>
  );
}

/** Joins selection rectangles on the same line into one box per line. */
function mergeLines(rects: { x: number; y: number; w: number; h: number }[]) {
  const sorted = [...rects].sort((a, b) => b.y - a.y || a.x - b.x);
  const out: typeof rects = [];
  for (const r of sorted) {
    const l = out[out.length - 1];
    if (l && Math.abs(l.y - r.y) < Math.min(l.h, r.h) * 0.5 && r.x <= l.x + l.w + 3) {
      const x = Math.min(l.x, r.x), y = Math.min(l.y, r.y);
      out[out.length - 1] = { x, y, w: Math.max(l.x + l.w, r.x + r.w) - x, h: Math.max(l.y + l.h, r.y + r.h) - y };
    } else out.push({ ...r });
  }
  return out;
}

function startPan(e: PointerEvent, c: HTMLDivElement) {
  const sx = e.clientX, sy = e.clientY, top = c.scrollTop, left = c.scrollLeft;
  const move = (m: PointerEvent) => { c.scrollTop = top - (m.clientY - sy); c.scrollLeft = left - (m.clientX - sx); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function collectResults(find: PDFFindController) {
  const f = find as unknown as { pageMatches: number[][]; _pageContents?: string[]; pageContents?: string[] };
  const contents = f._pageContents ?? f.pageContents ?? [];
  const out: { page: number; text: string; index: number }[] = [];
  (f.pageMatches ?? []).forEach((matches, page) => (matches ?? []).forEach((m, index) => {
    const text = contents[page] ?? '';
    out.push({ page, index, text: text.slice(Math.max(0, m - 30), m + 50).replace(/\s+/g, ' ') });
  }));
  searchResults.value = out.slice(0, 500);
}
