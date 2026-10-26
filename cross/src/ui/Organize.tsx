import { useState } from 'preact/hooks';
import type { DocModel } from '../pdf/doc';
import { dialog, organizing } from '../app/store';
import { edit, extractPagesTo, goTo, insertFromFiles } from '../app/actions';
import * as ops from '../pdf/ops';
import { Thumb } from './Sidebar';
import { Icon } from './icons';

export function Organize({ doc }: { doc: DocModel }) {
  const n = doc.js?.numPages ?? 0;
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [size, setSize] = useState(150);
  const [dragging, setDragging] = useState<number | null>(null);
  const chosen = sel.size ? [...sel].sort((a, b) => a - b) : [];
  const run = async (label: string, fn: Parameters<typeof edit>[1]) => { await edit(label, fn); setSel(new Set()); };
  const toggle = (i: number, e: MouseEvent) => {
    const next = new Set(e.metaKey || e.ctrlKey ? sel : []);
    if (e.shiftKey && sel.size) { const a = Math.min(...sel); for (let k = Math.min(a, i); k <= Math.max(a, i); k++) next.add(k); }
    else if (next.has(i) && (e.metaKey || e.ctrlKey)) next.delete(i); else next.add(i);
    setSel(next);
  };
  return (
    <div class="organize">
      <div class="organize-bar glass">
        <button class="icon-btn" title="Rotate left" disabled={!chosen.length} onClick={() => run('Rotate', (d) => ops.rotatePages(d, chosen, -90))}><Icon name="rotccw" /></button>
        <button class="icon-btn" title="Rotate right" disabled={!chosen.length} onClick={() => run('Rotate', (d) => ops.rotatePages(d, chosen, 90))}><Icon name="rotcw" /></button>
        <button class="icon-btn" title="Delete" disabled={!chosen.length} onClick={() => run('Delete Pages', (d) => ops.deletePages(d, chosen))}><Icon name="trash" /></button>
        <span class="sep" />
        <button class="icon-btn" title="Insert blank page" onClick={() => run('Insert Page', (d) => ops.insertBlank(d, chosen.length ? chosen[chosen.length - 1] : n - 1))}><Icon name="plus" /></button>
        <button class="icon-btn" title="Insert from file" onClick={() => insertFromFiles(chosen.length ? chosen[chosen.length - 1] : n - 1)}><Icon name="combine" /></button>
        <button class="icon-btn" title="Duplicate" disabled={!chosen.length} onClick={() => run('Duplicate', (d) => ops.duplicate(d, chosen))}><Icon name="copy" /></button>
        <button class="icon-btn" title="Extract to new PDF" disabled={!chosen.length} onClick={() => extractPagesTo(chosen)}><Icon name="output" /></button>
        <button class="icon-btn" title="Split" onClick={() => (dialog.value = { kind: 'split' })}><Icon name="scissors" /></button>
        <button class="icon-btn" title="Reverse order" onClick={() => run('Reverse', (d) => ops.reorder(d, d.getPageIndices().reverse()))}><Icon name="reverse" /></button>
        <span class="grow" />
        <span class="muted">{chosen.length ? `${chosen.length}/${n}` : `${n} pages`}</span>
        <input type="range" min="90" max="300" value={size} onInput={(e) => setSize(Number((e.target as HTMLInputElement).value))} title="Thumbnail size" />
        <button class="glass-btn" onClick={() => (organizing.value = false)}>Done</button>
      </div>
      <div class="organize-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size + 24}px, 1fr))` }}>
        {[...Array(n).keys()].map((i) => (
          <div key={i} class={`org-item ${sel.has(i) ? 'on' : ''} ${dragging === i ? 'dragging' : ''}`} draggable
            onClick={(e) => toggle(i, e)} onDblClick={() => { organizing.value = false; setTimeout(() => goTo(i), 50); }}
            onDragStart={() => { setDragging(i); if (!sel.has(i)) setSel(new Set([i])); }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragging === null) return;
              const moving = sel.has(dragging) ? [...sel].sort((a, b) => a - b) : [dragging];
              if (moving.includes(i)) { setDragging(null); return; }
              const rest = [...Array(n).keys()].filter((k) => !moving.includes(k));
              const at = rest.indexOf(i) + (i > Math.max(...moving) ? 1 : 0);
              rest.splice(at, 0, ...moving);
              setDragging(null);
              void run('Move Pages', (d) => ops.reorder(d, rest));
            }}>
            <Thumb doc={doc} index={i} width={size} />
            <span>{i + 1}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
