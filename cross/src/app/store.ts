// App-wide state: open documents (tabs), the active tool and panel, styles and dialogs.
import { effect, computed, signal } from '@preact/signals';
import { DocModel } from '../pdf/doc';
import type { AnnotInfo } from '../pdf/annots';
import type { GraphicObject } from '../engine/pageContent';
import { platform, type OpenedFile } from './platform';

export type Tool =
  | 'select' | 'hand' | 'editContent'
  | 'highlight' | 'underline' | 'strikeout' | 'note' | 'text' | 'ink' | 'rect' | 'oval' | 'line' | 'arrow' | 'eraser'
  | 'stamp' | 'check' | 'cross' | 'dot' | 'date'
  | 'whiteout' | 'link' | 'crop' | 'redact' | 'textField' | 'checkbox' | 'dropdown';

export type Panel = 'edit' | 'comment' | 'sign' | 'organize' | 'forms' | 'redact' | 'protect' | 'ocr' | 'compress' | 'export' | 'more';

export const TOOL_INFO: Record<Tool, { title: string; icon: string }> = {
  select: { title: 'Select', icon: 'cursor' }, hand: { title: 'Hand', icon: 'hand' }, editContent: { title: 'Edit Text & Images', icon: 'textcursor' },
  highlight: { title: 'Highlight', icon: 'highlighter' }, underline: { title: 'Underline', icon: 'underline' }, strikeout: { title: 'Strikethrough', icon: 'strike' },
  note: { title: 'Sticky Note', icon: 'note' }, text: { title: 'Add Text', icon: 'textbox' }, ink: { title: 'Draw', icon: 'pen' },
  rect: { title: 'Rectangle', icon: 'square' }, oval: { title: 'Oval', icon: 'circle' }, line: { title: 'Line', icon: 'line' }, arrow: { title: 'Arrow', icon: 'arrow' },
  eraser: { title: 'Eraser', icon: 'eraser' }, stamp: { title: 'Place', icon: 'stamp' }, check: { title: 'Checkmark', icon: 'check' },
  cross: { title: 'Cross', icon: 'x' }, dot: { title: 'Dot', icon: 'dot' }, date: { title: 'Date', icon: 'calendar' },
  whiteout: { title: 'Whiteout', icon: 'whiteout' }, link: { title: 'Link', icon: 'link' }, crop: { title: 'Crop', icon: 'crop' },
  redact: { title: 'Mark for Redaction', icon: 'eyeoff' }, textField: { title: 'Text Field', icon: 'field' }, checkbox: { title: 'Checkbox', icon: 'checkbox' },
  dropdown: { title: 'Dropdown', icon: 'dropdown' },
};

export const PANELS: { id: Panel; title: string; icon: string }[] = [
  { id: 'edit', title: 'Edit PDF', icon: 'edit' }, { id: 'comment', title: 'Comment', icon: 'comment' }, { id: 'sign', title: 'Fill & Sign', icon: 'sign' },
  { id: 'organize', title: 'Organize', icon: 'grid' }, { id: 'forms', title: 'Prepare Form', icon: 'form' }, { id: 'redact', title: 'Redact', icon: 'eyeoff' },
  { id: 'protect', title: 'Protect', icon: 'lock' }, { id: 'ocr', title: 'Scan & OCR', icon: 'scan' }, { id: 'compress', title: 'Compress', icon: 'compress' },
  { id: 'export', title: 'Export', icon: 'export' }, { id: 'more', title: 'More Tools', icon: 'more' },
];

export const docs = signal<DocModel[]>([]);
export const activeId = signal<number | null>(null);
export const active = computed(() => docs.value.find((d) => d.id === activeId.value) ?? null);

export const tool = signal<Tool>('select');
export const panel = signal<Panel>('edit');
export const showSidebar = signal(window.innerWidth > 900);
export const showPanel = signal(window.innerWidth > 1100);
// On phones and narrow windows the sidebar and the tools sheet overlay the page, so only one shows at a time.
const narrow = () => window.innerWidth <= 860;
effect(() => { if (showPanel.value && narrow()) showSidebar.value = false; });
effect(() => { if (showSidebar.value && narrow()) showPanel.value = false; });
export const sidebarMode = signal<'thumbs' | 'outline' | 'comments' | 'search'>('thumbs');
export const organizing = signal(false);

export const color = signal<[number, number, number]>([1, 0.84, 0.1]);
export const lineWidth = signal(2);
export const fontSize = signal(14);
export const placing = signal<{ png: Uint8Array; kind: string; w: number; h: number } | null>(null);

export const selectedAnnot = signal<AnnotInfo | null>(null);
export const editObject = signal<{ page: number; object: GraphicObject } | null>(null);
export const editStyle = signal<import('../pdf/editing').TextStyle | null>(null);
export const pageIndex = signal(0);
export const scale = signal(1);
export const search = signal('');
export const searchResults = signal<{ page: number; text: string; index: number }[]>([]);

export const toast = signal<string | null>(null);
export const busy = signal<{ label: string; progress?: number } | null>(null);
export const dialog = signal<{ kind: string; props?: Record<string, unknown> } | null>(null);

let toastTimer = 0;
export function showToast(message: string) {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = null), 3200);
}

/** Runs a long task with the progress overlay and reports failures. */
export async function task<T>(label: string, work: (progress: (p: number) => void) => Promise<T>): Promise<T | undefined> {
  busy.value = { label };
  try {
    return await work((p) => (busy.value = { label, progress: p }));
  } catch (e) {
    showToast(`${label.replace('…', '')} failed: ${(e as Error).message}`);
    console.error(e);
    return undefined;
  } finally {
    busy.value = null;
  }
}

export async function openDocument(file: OpenedFile) {
  const existing = file.path ? docs.value.find((d) => d.path === file.path) : undefined;
  if (existing) { activeId.value = existing.id; return; }
  const model = new DocModel(file.name, file.bytes, file.path);
  try {
    await model.load();
  } catch (e) {
    if ((e as Error).name !== 'PasswordException') { showToast(`Couldn't open ${file.name}: ${(e as Error).message}`); return; }
    const password = await askPassword(file.name);
    if (password === null) return;
    try { await model.load(password); } catch { showToast('Incorrect password'); return; }
  }
  docs.value = [...docs.value, model];
  activeId.value = model.id;
  organizing.value = false;
  remember(file);
}

export function newDocument(name: string, bytes: Uint8Array) {
  return openDocument({ name, bytes });
}

export function closeDocument(id: number) {
  const d = docs.value.find((x) => x.id === id);
  if (d?.dirty.value && !confirm(`Close “${d.name}” without saving?`)) return;
  void d?.js?.loadingTask.destroy();
  docs.value = docs.value.filter((x) => x.id !== id);
  if (activeId.value === id) activeId.value = docs.value[docs.value.length - 1]?.id ?? null;
}

function askPassword(name: string): Promise<string | null> {
  return new Promise((resolve) => { dialog.value = { kind: 'prompt', props: { title: `“${name}” is password protected`, label: 'Password', secure: true, resolve } }; });
}

export function prompt(title: string, initial = '', label = '', message = ''): Promise<string | null> {
  return new Promise((resolve) => { dialog.value = { kind: 'prompt', props: { title, initial, label, message, resolve } }; });
}

export function choose(title: string, options: string[], message = ''): Promise<number | null> {
  return new Promise((resolve) => { dialog.value = { kind: 'choose', props: { title, options, message, resolve } }; });
}

// Recent files (Windows keeps paths and reopens them; elsewhere it's a list of names).
export const recents = signal<{ name: string; path?: string; at: number }[]>(JSON.parse(localStorage.getItem('mkpdf.recents') ?? '[]'));
function remember(file: OpenedFile) {
  recents.value = [{ name: file.name, path: file.path, at: Date.now() }, ...recents.value.filter((r) => (file.path ? r.path !== file.path : r.name !== file.name))].slice(0, 15);
  localStorage.setItem('mkpdf.recents', JSON.stringify(recents.value));
}
export function clearRecents() { recents.value = []; localStorage.removeItem('mkpdf.recents'); }

export async function saveActive(saveAs = false) {
  const d = active.value;
  if (!d) return;
  await task('Saving…', async () => {
    const bytes = await d.saveBytes();
    const name = d.name.toLowerCase().endsWith('.pdf') ? d.name : `${d.name}.pdf`;
    const r = await platform.saveFile(name, bytes, 'application/pdf', d.path, saveAs || !d.path);
    if (!r) return;
    if (r.path) { d.path = r.path; d.name = r.path.split(/[\\/]/).pop() ?? d.name; }
    d.markSaved();
    docs.value = [...docs.value];
    showToast(`Saved to ${r.label}`);
  });
}
