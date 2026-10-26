import { useEffect } from 'preact/hooks';
import {
  active, activeId, busy, closeDocument, dialog, docs, openDocument, organizing, pageIndex, panel, saveActive, scale, showPanel,
  showSidebar, showToast, toast, tool, TOOL_INFO, Tool,
} from '../app/store';
import * as actions from '../app/actions';
import { platform } from '../app/platform';
import { Viewer, viewerApi } from './Viewer';
import { Sidebar } from './Sidebar';
import { ToolsPanel } from './Panels';
import { Organize } from './Organize';
import { Home } from './Home';
import { Dialogs } from './Dialogs';
import { UpdateBanner, checkForUpdates } from './Update';
import { Icon } from './icons';

function Tabs() {
  return (
    <nav class="tabs">
      <button class={`tab home-tab ${activeId.value === null ? 'on' : ''}`} title="Home" onClick={() => (activeId.value = null)}>
        <img src="icon.png" alt="" width={18} height={18} />
      </button>
      {docs.value.map((d) => (
        <div key={d.id} class={`tab ${activeId.value === d.id ? 'on' : ''}`} onClick={() => (activeId.value = d.id)} title={d.path ?? d.name}>
          <span class="tab-name">{d.dirty.value ? '● ' : ''}{d.name}</span>
          <button class="tab-close" title="Close" onClick={(e) => { e.stopPropagation(); closeDocument(d.id); }}>✕</button>
        </div>
      ))}
      <button class="tab add" title="Open" onClick={actions.openFiles}>+</button>
    </nav>
  );
}

const QUICK: Tool[] = ['select', 'hand', 'editContent', 'highlight', 'note', 'text', 'ink'];

function Toolbar() {
  const d = active.value!;
  const n = d.js?.numPages ?? 0;
  const zoom = (f: number) => { const v = viewerApi.current?.viewer; if (v) v.currentScale = Math.min(10, Math.max(0.1, v.currentScale * f)); };
  return (
    <header class="toolbar glass">
      <button class="icon-btn" title="Sidebar" onClick={() => (showSidebar.value = !showSidebar.value)}><Icon name="sidebar" /></button>
      <div class="group">
        <button class="icon-btn" title="Previous page" disabled={pageIndex.value <= 0} onClick={() => actions.goTo(pageIndex.value - 1)}><Icon name="prev" /></button>
        <input class="page-field" value={pageIndex.value + 1} onChange={(e) => actions.goTo(Math.max(0, Math.min(n - 1, Number((e.target as HTMLInputElement).value) - 1)))} />
        <span class="muted">/ {n}</span>
        <button class="icon-btn" title="Next page" disabled={pageIndex.value >= n - 1} onClick={() => actions.goTo(pageIndex.value + 1)}><Icon name="next" /></button>
      </div>
      <div class="group hide-narrow">
        <button class="icon-btn" title="Zoom out" onClick={() => zoom(1 / 1.2)}><Icon name="zoomout" /></button>
        <button class="zoom" title="Fit width" onClick={() => viewerApi.current && (viewerApi.current.viewer.currentScaleValue = 'page-width')}>{Math.round(scale.value * 100)}%</button>
        <button class="icon-btn" title="Zoom in" onClick={() => zoom(1.2)}><Icon name="zoomin" /></button>
      </div>
      <div class="group tools">
        {QUICK.map((t) => (
          <button key={t} class={`icon-btn ${tool.value === t ? 'on' : ''}`} title={TOOL_INFO[t].title}
            onClick={() => { tool.value = tool.value === t ? 'select' : t; organizing.value = false; if (t === 'editContent') { panel.value = 'edit'; showPanel.value = true; } }}>
            <Icon name={TOOL_INFO[t].icon} />
          </button>
        ))}
        <button class="icon-btn" title="Fill & Sign" onClick={() => { panel.value = 'sign'; showPanel.value = true; }}><Icon name="sign" /></button>
      </div>
      <span class="grow" />
      <div class="group">
        <button class="icon-btn" title={d.canUndo ? `Undo ${d.undoLabel}` : 'Undo'} disabled={!d.canUndo} onClick={actions.undo}><Icon name="undo" /></button>
        <button class="icon-btn" title={d.canRedo ? `Redo ${d.redoLabel}` : 'Redo'} disabled={!d.canRedo} onClick={actions.redo}><Icon name="redo" /></button>
        <button class={`icon-btn ${organizing.value ? 'on' : ''}`} title="Organize pages" onClick={() => (organizing.value = !organizing.value)}><Icon name="grid" /></button>
        <button class="icon-btn" title="Save" onClick={() => saveActive(false)}><Icon name="save" /></button>
        {platform.share && <button class="icon-btn" title="Share" onClick={actions.shareActive}><Icon name="share" /></button>}
        <button class={`icon-btn ${showPanel.value ? 'on' : ''}`} title="All tools" onClick={() => (showPanel.value = !showPanel.value)}><Icon name="panel" /></button>
      </div>
    </header>
  );
}

function Busy() {
  const b = busy.value;
  if (!b) return null;
  return (
    <div class="scrim busy">
      <div class="sheet glass small">
        {b.progress !== undefined ? <progress value={b.progress} max={1} /> : <div class="spinner" />}
        <b>{b.label}</b>
      </div>
    </div>
  );
}

export function App() {
  const d = active.value;
  useEffect(() => {
    platform.onOpenFile((f) => void openDocument(f));
    const key = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = (e.target as HTMLElement)?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName);
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); void actions.openFiles(); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void saveActive(e.shiftKey); }
      else if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); void (e.shiftKey ? actions.redo() : actions.undo()); }
      else if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); void actions.redo(); }
      else if (mod && e.key.toLowerCase() === 'w' && activeId.value !== null) { e.preventDefault(); closeDocument(activeId.value); }
      else if (mod && e.key === 'Tab' && docs.value.length) {
        e.preventDefault();
        const i = docs.value.findIndex((x) => x.id === activeId.value);
        activeId.value = docs.value[(i + (e.shiftKey ? -1 : 1) + docs.value.length) % docs.value.length].id;
      } else if (mod && e.key.toLowerCase() === 'f' && d) { e.preventDefault(); (document.querySelector('.search .field') as HTMLInputElement | null)?.focus(); }
      else if (e.key === 'Escape' && !typing) tool.value = 'select';
    };
    window.addEventListener('keydown', key);
    const drop = async (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      for (const f of e.dataTransfer.files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') await openDocument({ name: f.name, bytes, path: (f as File & { path?: string }).path });
        else if (f.type.startsWith('image/')) await actions.combineFiles([{ name: f.name, bytes }]);
      }
    };
    const over = (e: DragEvent) => e.preventDefault();
    window.addEventListener('drop', drop);
    window.addEventListener('dragover', over);
    platform.confirmClose?.(() => docs.value.some((x) => x.dirty.value));
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('drop', drop); window.removeEventListener('dragover', over); };
  }, []);

  return (
    <div class="app">
      <div class="backdrop" />
      <Tabs />
      <UpdateBanner />
      {!d && <Home />}
      {d && (
        <div class="workspace">
          <Toolbar />
          <div class="work">
            {showSidebar.value && !organizing.value && <Sidebar doc={d} />}
            <main class="stage">{organizing.value ? <Organize doc={d} /> : <Viewer key={d.id} doc={d} />}</main>
            {showPanel.value && <ToolsPanel />}
            {!showPanel.value && <button class="fab glass-btn prominent" onClick={() => (showPanel.value = true)}><Icon name="panel" />Tools</button>}
          </div>
        </div>
      )}
      <Dialogs />
      <Busy />
      {toast.value && <div class="toast glass">{toast.value}</div>}
    </div>
  );
}

export { checkForUpdates, showToast };
