import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { hasArabic } from '../pdf/fonts';
import { coverRects, isScanned, sampleColors } from '../pdf/scan';
import { PDFDocument } from 'pdf-lib';
import type { PageViewport } from 'pdfjs-dist';
import type { DocModel } from '../pdf/doc';
import {
  color, editObject, editStyle, fontSize, lineWidth, placing, prompt, selectedAnnot, showToast, tool, choose,
} from '../app/store';
import { addLinkAt, edit } from '../app/actions';
import * as annots from '../pdf/annots';
import * as ops from '../pdf/ops';
import * as editing from '../pdf/editing';
import { LayoutParagraph, layoutPage, lineText, paragraphText } from '../engine/layout';
import { pageTextItems } from '../engine/textItems';
import { GraphicObject, PageContent, Rect, containsRect, maxX, maxY, union } from '../engine/pageContent';
import type { AnnotInfo } from '../pdf/annots';
import { loadPdf } from '../engine/load';

type P = { x: number; y: number };

// Read-only pdf-lib copy of a document per version, shared by every page overlay.
const libs = new WeakMap<DocModel, { version: number; doc: Promise<PDFDocument> }>();
export function readDoc(doc: DocModel): Promise<PDFDocument> {
  const v = doc.version.peek();
  let e = libs.get(doc);
  if (!e || e.version !== v) { e = { version: v, doc: loadPdf(doc.bytes, { updateMetadata: false }) }; libs.set(doc, e); }
  return e.doc;
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): T | null {
  const [v, setV] = useState<T | null>(null);
  useEffect(() => { let alive = true; fn().then((r) => alive && setV(r)).catch(() => alive && setV(null)); return () => { alive = false; }; }, deps);
  return v;
}

const DRAG_TOOLS = new Set(['rect', 'oval', 'line', 'arrow', 'whiteout', 'retype', 'redact', 'link', 'crop', 'textField', 'checkbox', 'dropdown']);

export function PageOverlay({ doc, page, viewport }: { doc: DocModel; page: number; viewport: PageViewport }) {
  const layer = useRef<HTMLDivElement>(null);
  const version = doc.version.value;
  const t = tool.value;
  const list = useAsync(async () => annots.listAnnots(await readDoc(doc)).filter((a) => a.page === page), [doc, version, page]);
  const editing_ = t === 'editContent';
  const content = useAsync(async () => {
    if (!editing_ || !doc.js) return null;
    const lib = await readDoc(doc);
    const pc = new PageContent(lib, lib.getPage(page));
    const layout = layoutPage(lib, page, await pageTextItems(doc.js, page + 1), pc);
    // Every paragraph, plus each table cell, can be edited.
    const blocks: LayoutParagraph[] = layout.items.flatMap((i) => i.kind === 'paragraph' ? [i]
      : i.kind === 'table' ? i.cells.filter((c) => c.lines.length).map((c) => ({
        kind: 'paragraph' as const, rect: c.lines.reduce<Rect>((a, l) => union(a, l.rect)!, c.lines[0].rect), lines: c.lines,
        alignment: c.alignment, rtl: c.rtl, pitch: c.pitch,
      }))
        : []);
    // Skip full-page backgrounds (a scan behind recognised text); they're rarely what the user means to grab.
    const c = lib.getPage(page).getCropBox();
    const inner = { x: c.x + 4, y: c.y + 4, w: c.width - 8, h: c.height - 8 };
    const objects = pc.objects.filter((o) => o.kind !== 'form' && o.bounds.w > 4 && o.bounds.h > 4 && !containsRect(o.bounds, inner));
    return { blocks, objects };
  }, [doc, version, page, editing_]);

  const [drag, setDrag] = useState<{ a: P; b: P } | null>(null);
  const [ink, setInk] = useState<P[] | null>(null);
  const [moving, setMoving] = useState<{ kind: 'annot' | 'object' | 'block'; start: P; now: P; resize: boolean; target: unknown } | null>(null);
  const [editor, setEditor] = useState<{ block: LayoutParagraph | null; origin: P; text: string } | null>(null);

  const toPdf = (e: { clientX: number; clientY: number }): P => {
    const r = layer.current!.getBoundingClientRect();
    const [x, y] = viewport.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
    return { x, y };
  };
  const box = (r: Rect) => {
    const [a, b] = viewport.convertToViewportPoint(r.x, r.y) as number[];
    const [c, d] = viewport.convertToViewportPoint(r.x + r.w, r.y + r.h) as number[];
    return { left: Math.min(a, c), top: Math.min(b, d), width: Math.abs(c - a), height: Math.abs(d - b) };
  };
  const rectOf = (a: P, b: P): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  const s = viewport.scale;

  // Delete key removes the selected annotation or image on this page.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.isContentEditable || ['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const a = selectedAnnot.value, o = editObject.value;
      if (a && a.page === page) { e.preventDefault(); void edit('Delete Annotation', (d) => annots.deleteAnnot(d, a)); }
      else if (o && o.page === page) { e.preventDefault(); void edit('Delete Image', (d) => editing.deleteObject(d, page, o.object)); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [page]);

  const onDown = async (e: PointerEvent) => {
    if (e.button !== 0) return;
    const p = toPdf(e);
    const c = color.value;
    if (DRAG_TOOLS.has(t)) { layer.current!.setPointerCapture(e.pointerId); setDrag({ a: p, b: p }); return; }
    if (t === 'ink') { layer.current!.setPointerCapture(e.pointerId); setInk([p]); return; }
    if (t === 'note') { const text = await prompt('Sticky note', '', 'Comment'); if (text !== null) await edit('Add Note', (d) => annots.addNote(d, page, p.x, p.y, c, text)); tool.value = 'select'; return; }
    if (t === 'text') {
      const text = await prompt('Add text', '', 'Text');
      if (text) await edit('Add Text', (d) => annots.addFreeText(d, page, p.x, p.y, text, fontSize.value, c[0] > 0.9 && c[1] > 0.7 ? [0, 0, 0] : c));
      tool.value = 'select';
      return;
    }
    const marks: Record<string, string> = { check: '✓', cross: '✗', dot: '●' };
    if (t in marks || t === 'date') {
      const value = t === 'date' ? new Date().toLocaleDateString() : marks[t];
      await edit(t === 'date' ? 'Date' : 'Mark', (d) => annots.addFreeText(d, page, p.x, p.y, value, Math.max(fontSize.value, 14), [0, 0, 0], { family: 'Noto Sans' }));
      return;
    }
    if (t === 'stamp' && placing.value) {
      const pl = placing.value;
      const max = pl.kind === 'Stamp' ? 200 : pl.kind === 'Initials' ? 70 : 170;
      const k = Math.min(max / pl.w, 1.5), w = pl.w * k, h = pl.h * k;
      await edit(`Place ${pl.kind}`, (d) => annots.addImageStamp(d, page, { x: p.x - w / 2, y: p.y - h / 2, w, h }, pl.png, pl.kind));
      tool.value = 'select';
      return;
    }
    if (t === 'editContent') {
      // Empty space: start new text there (double-click or tap with "Add text" armed).
      editObject.value = null;
      if (e.detail >= 2) openEditor(null, p, '');
    }
  };

  const onMove = (e: PointerEvent) => {
    if (drag) setDrag({ a: drag.a, b: toPdf(e) });
    else if (ink) setInk([...ink, toPdf(e)]);
    else if (moving) setMoving({ ...moving, now: toPdf(e) });
  };

  const onUp = async () => {
    if (drag) {
      const r = rectOf(drag.a, drag.b);
      const tiny = r.w < 4 && r.h < 4;
      setDrag(null);
      const c = color.value, w = lineWidth.value;
      if (['rect', 'oval', 'line', 'arrow'].includes(t) && !tiny) {
        await edit(t === 'rect' ? 'Rectangle' : t === 'oval' ? 'Oval' : t === 'line' ? 'Line' : 'Arrow',
          (d) => annots.addShape(d, page, t === 'rect' ? 'Square' : t === 'oval' ? 'Circle' : t === 'line' ? 'Line' : 'Arrow', drag.a, drag.b, c, w));
      } else if (t === 'whiteout' && !tiny) await edit('Whiteout', (d) => annots.addWhiteout(d, page, r));
      else if (t === 'retype' && !tiny) await (await import('../app/actions')).coverAndRetype(page, r);
      else if (t === 'redact' && !tiny) await edit('Mark for Redaction', (d) => annots.addRedactionMark(d, page, r));
      else if (t === 'link' && !tiny) await addLinkAt(page, r);
      else if (t === 'crop' && !tiny) {
        const all = await choose('Crop pages', ['This page', 'All pages']);
        if (all !== null) await edit('Crop', (d) => ops.cropPages(d, all ? d.getPageIndices() : [page], r));
        tool.value = 'select';
      } else if (t === 'textField' || t === 'checkbox' || t === 'dropdown') {
        const size = t === 'checkbox' ? { w: 16, h: 16 } : { w: 180, h: 22 };
        const fr = tiny ? { x: drag.a.x, y: drag.a.y - size.h, ...size } : r;
        let options: string[] = [];
        if (t === 'dropdown') {
          const v = await prompt('Dropdown options', 'Option 1, Option 2, Option 3', 'Separate choices with commas');
          if (v === null) return;
          options = v.split(',').map((x) => x.trim()).filter(Boolean);
        }
        await edit('Add Field', (d) => ops.addFormField(d, page, t === 'textField' ? 'text' : t, fr, options));
      }
      return;
    }
    if (ink) {
      const pts = ink;
      setInk(null);
      if (pts.length > 1) await edit('Draw', (d) => annots.addInk(d, page, [pts], color.value, lineWidth.value));
      return;
    }
    if (moving) {
      const m = moving;
      setMoving(null);
      const dx = m.now.x - m.start.x, dy = m.now.y - m.start.y;
      if (m.kind === 'annot') {
        const a = m.target as AnnotInfo;
        if (Math.hypot(dx, dy) < 1) return;
        const to = moved(a.rect, dx, dy, m.resize, true);
        await edit(m.resize ? 'Resize' : 'Move', (d) => annots.setAnnotRect(d, a, to));
      } else if (m.kind === 'object') {
        const o = m.target as GraphicObject;
        if (Math.hypot(dx, dy) < 1) return;
        await edit(m.resize ? 'Resize Image' : 'Move Image', (d) => editing.moveObject(d, page, o, moved(o.bounds, dx, dy, m.resize, true)));
      } else {
        const b = m.target as LayoutParagraph;
        if (Math.hypot(dx, dy) * s < 4) return openEditor(b, { x: b.lines[0].rect.x, y: b.lines[0].baseline }, paragraphText(b));
        const st = editing.styleOf(b);
        await edit('Move Text', (d) => editing.commitText(d, page, b, paragraphText(b), st, { x: b.lines[0].rect.x + dx, y: b.lines[0].baseline + dy },
          b.lines.length > 1 ? b.rect.w + 2 : undefined, b.rect.w));
      }
    }
  };

  const moved = (r: Rect, dx: number, dy: number, resize: boolean, keepRatio: boolean): Rect => {
    if (!resize) return { ...r, x: r.x + dx, y: r.y + dy };
    const w = Math.max(8, r.w + dx);
    const h = keepRatio ? (w * r.h) / r.w : Math.max(8, r.h - dy);
    return { x: r.x, y: maxY(r) - h, w, h };
  };

  const openEditor = (block: LayoutParagraph | null, origin: P, text: string) => {
    editStyle.value = block ? editing.styleOf(block) : { family: 'Noto Sans', bold: false, italic: false, size: fontSize.value, color: [0, 0, 0], alignment: 'left' };
    setEditor({ block, origin, text });
  };

  const commitEditor = async (text: string | null) => {
    const ed = editor;
    const st = editStyle.value;
    setEditor(null);
    editStyle.value = null;
    if (!ed || text === null || !st) return;
    if (ed.block && text === paragraphText(ed.block) && JSON.stringify(st) === JSON.stringify(editing.styleOf(ed.block))) return;
    if (!ed.block && !text.trim()) return;
    const b = ed.block;
    // Recognised text over a scan: cover the old pixels, and keep the page's ink colour unless it was changed.
    let cover: { rects: Rect[]; paper: [number, number, number] } | undefined;
    let style = st;
    if (b && isScanned(b) && doc.js) {
      const { paper, ink } = await sampleColors(doc.js, page, b.rect);
      cover = { rects: coverRects(b), paper };
      if (JSON.stringify(st.color) === JSON.stringify(editing.styleOf(b).color)) style = { ...st, color: ink };
    }
    await edit(b ? 'Edit Text' : 'Add Text', (d) => editing.commitText(d, page, b, text, style, ed.origin,
      b && b.lines.length > 1 ? b.rect.w + 2 : undefined, b?.rect.w, cover));
  };

  const comments = (list ?? []).filter((a) => annots.isComment(a) || annots.isRedaction(a) || a.subtype === 'Widget' && t === 'select');
  const sel = selectedAnnot.value?.page === page ? selectedAnnot.value : null;
  const obj = editObject.value?.page === page ? editObject.value.object : null;
  const pointer = DRAG_TOOLS.has(t) || ['ink', 'note', 'text', 'stamp', 'check', 'cross', 'dot', 'date', 'editContent'].includes(t);
  // Preact 11 no longer adds px to numeric styles.
  const previewRect = (r: Rect) => { const b = box(r); return { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` }; };

  return (
    <div ref={layer} class={`mk-layer tool-${t}`} style={{ pointerEvents: pointer ? 'auto' : 'none' }}
      onPointerDown={onDown as never} onPointerMove={onMove as never} onPointerUp={onUp as never}>
      {(t === 'select' || t === 'eraser') && comments.map((a) => (
        <div key={a.index} class={`mk-hit ${sel?.index === a.index ? 'selected' : ''}`} style={previewRect(a.rect)} title={a.contents || a.subtype}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (t === 'eraser') { void edit('Delete Annotation', (d) => annots.deleteAnnot(d, a)); return; }
            selectedAnnot.value = a;
            (e.currentTarget as HTMLElement).parentElement!.setPointerCapture(e.pointerId);
            const p = toPdf(e);
            setMoving({ kind: 'annot', start: p, now: p, resize: false, target: a });
          }}>
          {sel?.index === a.index && <div class="mk-handle" onPointerDown={(e) => {
            e.stopPropagation();
            layer.current!.setPointerCapture(e.pointerId);
            const p = toPdf(e);
            setMoving({ kind: 'annot', start: p, now: p, resize: true, target: a });
          }} />}
        </div>
      ))}
      {moving && moving.kind !== 'block' && (() => {
        const r = moving.kind === 'annot' ? (moving.target as AnnotInfo).rect : (moving.target as GraphicObject).bounds;
        return <div class="mk-preview" style={previewRect(moved(r, moving.now.x - moving.start.x, moving.now.y - moving.start.y, moving.resize, moving.kind === 'object'))} />;
      })()}
      {moving?.kind === 'block' && Math.hypot(moving.now.x - moving.start.x, moving.now.y - moving.start.y) * s > 4 &&
        <div class="mk-preview" style={previewRect({ ...(moving.target as LayoutParagraph).rect, x: (moving.target as LayoutParagraph).rect.x + moving.now.x - moving.start.x, y: (moving.target as LayoutParagraph).rect.y + moving.now.y - moving.start.y })} />}

      {editing_ && content && !editor && content.blocks.map((b, i) => (
        <div key={i} class="mk-block" style={previewRect({ x: b.rect.x - 2, y: b.rect.y - 2, w: b.rect.w + 4, h: b.rect.h + 4 })}
          title={lineText(b.lines[0]).slice(0, 80)}
          onPointerDown={(e) => {
            e.stopPropagation();
            editObject.value = null;
            layer.current!.setPointerCapture(e.pointerId);
            const p = toPdf(e);
            setMoving({ kind: 'block', start: p, now: p, resize: false, target: b });
          }} />
      ))}
      {editing_ && content && !editor && content.objects.map((o) => (
        <div key={`o${o.opIndex}`} class={`mk-obj ${obj?.opIndex === o.opIndex ? 'selected' : ''}`} style={previewRect(o.bounds)}
          onPointerDown={(e) => {
            e.stopPropagation();
            editObject.value = { page, object: o };
            layer.current!.setPointerCapture(e.pointerId);
            const p = toPdf(e);
            setMoving({ kind: 'object', start: p, now: p, resize: false, target: o });
          }}>
          {obj?.opIndex === o.opIndex && <div class="mk-handle" onPointerDown={(e) => {
            e.stopPropagation();
            layer.current!.setPointerCapture(e.pointerId);
            const p = toPdf(e);
            setMoving({ kind: 'object', start: p, now: p, resize: true, target: o });
          }} />}
        </div>
      ))}
      {editor && <InlineEditor viewport={viewport} editor={editor} onDone={commitEditor} />}

      {(drag || ink) && (
        <svg class="mk-svg">
          {drag && (t === 'line' || t === 'arrow') && (() => {
            const [x1, y1] = viewport.convertToViewportPoint(drag.a.x, drag.a.y), [x2, y2] = viewport.convertToViewportPoint(drag.b.x, drag.b.y);
            return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={css(color.value)} stroke-width={lineWidth.value * s} />;
          })()}
          {drag && t !== 'line' && t !== 'arrow' && (() => {
            const b = box(rectOf(drag.a, drag.b));
            const cls = t === 'redact' ? 'redact' : t === 'whiteout' || t === 'retype' ? 'whiteout' : ['rect', 'oval'].includes(t) ? 'shape' : 'dashed';
            return t === 'oval'
              ? <ellipse cx={b.left + b.width / 2} cy={b.top + b.height / 2} rx={b.width / 2} ry={b.height / 2} class={cls} stroke={css(color.value)} stroke-width={lineWidth.value * s} />
              : <rect x={b.left} y={b.top} width={b.width} height={b.height} class={cls} stroke={cls === 'shape' ? css(color.value) : undefined} stroke-width={cls === 'shape' ? lineWidth.value * s : undefined} />;
          })()}
          {ink && <polyline points={ink.map((p) => viewport.convertToViewportPoint(p.x, p.y).join(',')).join(' ')} fill="none" stroke={css(color.value)} stroke-width={lineWidth.value * s} stroke-linecap="round" stroke-linejoin="round" />}
        </svg>
      )}
    </div>
  );
}

const css = (c: [number, number, number]) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;

/** Text editor sitting exactly over a paragraph, in its font, at the current zoom. */
function InlineEditor({ viewport, editor, onDone }: { viewport: PageViewport; editor: { block: LayoutParagraph | null; origin: P; text: string }; onDone: (t: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const st = editStyle.value!;
  const s = viewport.scale;
  const b = editor.block;
  const pitch = (b?.pitch ?? st.size * 1.2) * s;
  const [x, y] = viewport.convertToViewportPoint(editor.origin.x, editor.origin.y);
  const width = b ? b.rect.w * s + 6 : undefined;
  const style = useMemo(() => ({
    left: `${x - 3}px`, top: `${y - st.size * s * 0.95}px`, minWidth: `${Math.max(60, width ?? 120)}px`, width: b && b.lines.length > 1 ? `${width}px` : undefined,
    fontFamily: `'${st.family}', 'Noto Sans', 'Noto Naskh Arabic', sans-serif`, fontSize: `${st.size * s}px`, lineHeight: `${pitch}px`,
    fontWeight: st.bold ? 700 : 400, fontStyle: st.italic ? 'italic' : 'normal', color: css(st.color), textAlign: st.alignment === 'justify' ? 'left' : st.alignment,
    whiteSpace: b && b.lines.length > 1 ? 'pre-wrap' : 'pre',
  }), [x, y, s, st, width]);
  useEffect(() => {
    const el = ref.current!;
    el.innerText = editor.text;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, []);
  // Keep the style bar on the page, even on a phone where the page is narrower than the bar.
  useLayoutEffect(() => {
    const el = bar.current, host = el?.offsetParent as HTMLElement | null;
    if (!el || !host) return;
    const room = host.clientWidth - el.offsetWidth - 4;
    el.style.left = `${Math.max(4, Math.min(x - 3, room))}px`;
    const above = y - st.size * s * 0.95 - el.offsetHeight - 8;
    const ed = ref.current!;
    el.style.top = `${above >= 4 ? above : ed.offsetTop + ed.offsetHeight + 8}px`;
  });
  const done = () => onDone(ref.current?.innerText.replace(/\n$/, '') ?? null);
  const set = (p: Partial<typeof st>) => (editStyle.value = { ...st, ...p });
  return (
    <>
      <div ref={bar} class="mk-editbar glass" style={{ left: `${x - 3}px`, top: `${y - st.size * s * 0.95 - 46}px` }} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}>
        <button onClick={() => set({ size: Math.max(4, st.size - 1) })}>A−</button>
        <span class="mk-size">{st.size.toFixed(1)}</span>
        <button onClick={() => set({ size: st.size + 1 })}>A+</button>
        <button class={st.bold ? 'on' : ''} onClick={() => set({ bold: !st.bold })}><b>B</b></button>
        <button class={st.italic ? 'on' : ''} onClick={() => set({ italic: !st.italic })}><i>I</i></button>
        {(['left', 'center', 'right'] as const).map((a) => <button key={a} class={st.alignment === a ? 'on' : ''} onClick={() => set({ alignment: a })}>{a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥'}</button>)}
        <input type="color" value={'#' + st.color.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}
          onInput={(e) => { const h = (e.target as HTMLInputElement).value; set({ color: [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as never }); }} />
        <button class="primary" onClick={done}>Done</button>
        <button onClick={() => onDone(null)}>✕</button>
      </div>
      <div ref={ref} class="mk-editor" dir={b?.rtl || hasArabic(editor.text) ? 'rtl' : 'auto'} contentEditable style={style as never} onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onDone(null); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) done(); }}
        onBlur={(e) => { if (!(e.relatedTarget as HTMLElement | null)?.closest('.mk-editbar')) setTimeout(done, 0); }} />
    </>
  );
}

export { showToast };
