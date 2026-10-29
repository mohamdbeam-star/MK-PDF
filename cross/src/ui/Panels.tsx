import { useEffect, useState } from 'preact/hooks';
import { pageHasText } from '../pdf/scan';
import {
  PANELS, TOOL_INFO, Tool, active, color, dialog, editObject, editStyle, fontSize, lineWidth, organizing, pageIndex, panel, placing,
  selectedAnnot, showPanel, showToast, tool,
} from '../app/store';
import * as actions from '../app/actions';
import * as annots from '../pdf/annots';
import * as ops from '../pdf/ops';
import * as editing from '../pdf/editing';
import { PRESETS, Preset } from '../pdf/compress';
import { DOC_FORMATS } from '../pdf/exporter';
import { platform } from '../app/platform';
import { Icon } from './icons';
import { signatures, deleteSignature, stampImage, STAMPS } from './signatures';
import { layout, nightMode, rightToLeft, Layout } from '../app/store';
import { listFields, FieldInfo } from '../pdf/extras';

const PALETTE: [number, number, number][] = [[1, 0.84, 0.1], [0.3, 0.85, 0.4], [0.25, 0.55, 1], [1, 0.35, 0.6], [1, 0.55, 0.15], [0.6, 0.35, 0.95], [0.9, 0.15, 0.15], [0, 0, 0]];
const css = (c: number[]) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;

function Tools({ tools }: { tools: Tool[] }) {
  return (
    <div class="tool-grid">
      {tools.map((t) => (
        <button key={t} class={`tool glass-btn ${tool.value === t ? 'on' : ''}`} title={TOOL_INFO[t].title}
          onClick={() => { tool.value = tool.value === t ? 'select' : t; organizing.value = false; }}>
          <Icon name={TOOL_INFO[t].icon} />
          <span>{TOOL_INFO[t].title}</span>
        </button>
      ))}
    </div>
  );
}

function Row({ icon, title, detail, onClick }: { icon: string; title: string; detail?: string; onClick: () => void }) {
  return (
    <button class="row glass-btn" onClick={onClick}>
      <Icon name={icon} />
      <span class="row-text"><span>{title}</span>{detail && <small>{detail}</small>}</span>
    </button>
  );
}

const H = ({ children }: { children: string }) => <h4>{children}</h4>;

function Style({ font = true }: { font?: boolean }) {
  return (
    <div class="style">
      <div class="swatches">
        {PALETTE.map((c) => <button key={c.join()} class={`swatch ${color.value.join() === c.join() ? 'on' : ''}`} style={{ background: css(c) }} onClick={() => (color.value = c)} />)}
        <input type="color" onInput={(e) => { const h = (e.target as HTMLInputElement).value; color.value = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as never; }} />
      </div>
      <label>Line <input type="range" min="0.5" max="12" step="0.5" value={lineWidth.value} onInput={(e) => (lineWidth.value = Number((e.target as HTMLInputElement).value))} /> <span>{lineWidth.value}</span></label>
      {font && <label>Text <input type="range" min="6" max="48" step="1" value={fontSize.value} onInput={(e) => (fontSize.value = Number((e.target as HTMLInputElement).value))} /> <span>{fontSize.value}</span></label>}
    </div>
  );
}

function SelectedAnnotation() {
  const a = selectedAnnot.value;
  const [text, setText] = useState(a?.contents ?? '');
  if (!a) return null;
  return (
    <div class="card glass">
      <div class="card-head"><b>{annots.isRedaction(a) ? 'Redaction mark' : a.subtype === 'Stamp' ? a.contents || 'Picture' : a.subtype}</b>
        <button class="icon-btn" title="Delete" onClick={() => actions.edit('Delete Annotation', (d) => annots.deleteAnnot(d, a))}><Icon name="trash" /></button></div>
      {a.author && <small class="muted">{a.author}</small>}
      {a.subtype !== 'Stamp' && <>
        <textarea rows={3} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} placeholder="Comment" />
        <button class="glass-btn small" onClick={() => actions.edit('Edit Comment', (d) => (a.subtype === 'FreeText' ? annots.restyleFreeText(d, a, { text }) : annots.setContents(d, a, text)))}>Save comment</button>
      </>}
      {(a.subtype === 'Stamp' || a.subtype === 'FreeText') && <>
        <H>Place on other pages</H>
        <div class="chips">
          {['Every page', 'All but last', 'Last page', 'Range…'].map((label, i) => <button key={label} class="chip" onClick={async () => {
            const d = active.value!;
            const n = d.js!.numPages;
            let pages = i === 0 ? [...Array(n).keys()] : i === 1 ? [...Array(Math.max(1, n - 1)).keys()] : i === 2 ? [n - 1] : null;
            if (!pages) {
              const r = await (await import('../app/store')).prompt('Place on pages', `1-${n}`, 'Pages');
              pages = r ? ops.parseRanges(r, n) : null;
            }
            if (pages) await actions.edit('Place on Pages', (doc) => annots.copyAnnotToPages(doc, a, pages!));
          }}>{label}</button>)}
        </div>
      </>}
    </div>
  );
}

/** Shown in edit mode on a page with no text at all (a scan, or text drawn as shapes). */
function ScanPrompt() {
  const d = active.value;
  const [state, setState] = useState<{ key: string; empty: boolean } | null>(null);
  const key = `${d?.id}:${d?.version.value}:${pageIndex.value}`;
  useEffect(() => {
    if (!d?.js) return;
    let alive = true;
    void pageHasText(d.js, pageIndex.value).then((has) => alive && setState({ key, empty: !has }));
    return () => { alive = false; };
  }, [key]);
  if (!state || state.key !== key || !state.empty) return null;
  return (
    <div class="card glass scan-prompt">
      <b>No editable text on this page</b>
      <p class="hint">This page is a scanned image, or its text is drawn as shapes. Recognize the text to edit it in place: changes are painted over the original in matching size and colour.</p>
      <button class="glass-btn prominent" onClick={() => actions.runOcr([pageIndex.value], 'eng+ara', false)}><Icon name="scan" /> Make This Page Editable</button>
      <button class="glass-btn" onClick={() => actions.runOcr(null, 'eng+ara', true)}>All Scanned Pages</button>
    </div>
  );
}

function EditPanel() {
  const o = editObject.value;
  const on = tool.value === 'editContent';
  return (
    <>
      <button class={`big glass-btn ${on ? 'prominent' : 'prominent-outline'}`} onClick={() => {
        tool.value = on ? 'select' : 'editContent';
        // On a phone the sheet covers the page: get it out of the way to start editing.
        if (!on && window.innerWidth <= 860) showPanel.value = false;
      }}>
        <Icon name="textcursor" /> {on ? 'Done Editing' : 'Edit Text & Images'}
      </button>
      {on && <ScanPrompt />}
      {on && <p class="hint">Tap a paragraph to change its text, drag it to move it. Drag an image to move it, its corner to resize, Delete removes it. Double-tap empty space to add text.</p>}
      {on && o && <div class="card glass">
        <div class="card-head"><b>Image</b><small class="muted">{Math.round(o.object.bounds.w)} × {Math.round(o.object.bounds.h)} pt</small></div>
        <Row icon="imageplus" title="Replace image…" onClick={async () => {
          const [f] = await platform.openFiles('image/*', false);
          if (f) await actions.edit('Replace Image', (d) => editing.replaceObject(d, o.page, o.object, f.bytes));
        }} />
        <Row icon="download" title="Save as PNG…" onClick={() => actions.saveObjectAsPng(o.page, o.object.bounds)} />
        <Row icon="trash" title="Delete image" onClick={() => actions.edit('Delete Image', (d) => editing.deleteObject(d, o.page, o.object))} />
      </div>}
      {editStyle.value && <p class="hint">Style the text with the bar above it, then press Done.</p>}
      <H>Add</H>
      <Tools tools={['select', 'text', 'whiteout', 'link', 'crop', 'ink']} />
      <Row icon="image" title="Add image…" onClick={pickPicture} />
      <Row icon="textbox" title="Cover and retype selected text" detail="For text inside scans or drawings: drag a box over it" onClick={() => { tool.value = 'retype'; showToast('Drag a box over the text to replace.'); }} />
      <H>Page design</H>
      <Row icon="droplet" title="Watermark…" onClick={() => (dialog.value = { kind: 'watermark' })} />
      <Row icon="heading" title="Header & footer…" onClick={() => (dialog.value = { kind: 'headerFooter' })} />
      <Row icon="hash" title="Bates numbering…" onClick={() => (dialog.value = { kind: 'bates' })} />
      <Row icon="crop" title="Remove crop from all pages" onClick={() => actions.edit('Remove Crop', (d) => ops.cropPages(d, d.getPageIndices(), null))} />
    </>
  );
}

async function pickPicture() {
  const [f] = await platform.openFiles('image/*', false);
  if (!f) return;
  const { png, w, h } = await stampImage(f.bytes);
  placing.value = { png, kind: 'Image', w, h };
  tool.value = 'stamp';
  showToast('Tap the page where the image should go.');
}

function CommentPanel() {
  const [author, setAuthor] = useState(localStorage.getItem('mkpdf.author') ?? '');
  return (
    <>
      <Tools tools={['select', 'hand', 'highlight', 'underline', 'strikeout', 'note', 'text', 'ink', 'rect', 'oval', 'line', 'arrow', 'eraser']} />
      <H>Style</H>
      <Style />
      <H>Stamps</H>
      <div class="stamps">
        {STAMPS.map((s) => <button key={s.title} class="stamp glass-btn" style={{ color: s.color, borderColor: s.color }} onClick={async () => {
          const { png, w, h } = await stampImage(null, s, author || 'MK PDF');
          placing.value = { png, kind: 'Stamp', w, h };
          tool.value = 'stamp';
        }}>{s.title}</button>)}
      </div>
      <H>Comments</H>
      <Row icon="output" title="Export comment summary…" detail="Page, type, author and text of every comment" onClick={actions.exportCommentSummary} />
      <Row icon="layers" title="Flatten comments into pages" detail="Makes them part of the page" onClick={actions.flattenComments} />
      <Row icon="trash" title="Delete all comments" onClick={() => {
        if (confirm('Delete all comments?')) void actions.edit('Delete Comments', (d) => {
          for (const a of annots.listAnnots(d).filter(annots.isComment).sort((x, y) => y.page - x.page || y.index - x.index)) annots.deleteAnnot(d, a);
        });
      }} />
      <H>Author</H>
      <input class="field" value={author} placeholder="Your name" onInput={(e) => { const v = (e.target as HTMLInputElement).value; setAuthor(v); localStorage.setItem('mkpdf.author', v); }} />
    </>
  );
}

function SignPanel() {
  return (
    <>
      <p class="hint">Tap a form field to type into it, or place text and marks anywhere.</p>
      <Tools tools={['select', 'text', 'check', 'cross', 'dot', 'date']} />
      <H>Signatures</H>
      {!signatures.value.length && <p class="muted">No saved signatures yet.</p>}
      {signatures.value.map((s) => (
        <div class="sig glass" key={s.id}>
          <button class="sig-img" onClick={() => { placing.value = { png: s.png, kind: s.kind, w: s.w, h: s.h }; tool.value = 'stamp'; showToast('Tap the page to place it.'); }}>
            <img src={s.url} alt={s.kind} />
          </button>
          <button class="icon-btn" title="Delete" onClick={() => deleteSignature(s.id)}><Icon name="trash" /></button>
        </div>
      ))}
      <div class="chips">
        <button class="glass-btn" onClick={() => (dialog.value = { kind: 'signature', props: { kind: 'Signature' } })}><Icon name="plus" /> Signature</button>
        <button class="glass-btn" onClick={() => (dialog.value = { kind: 'signature', props: { kind: 'Initials' } })}><Icon name="plus" /> Initials</button>
      </div>
      <H>Finish</H>
      <Row icon="eraser" title="Clear form fields" onClick={() => actions.edit('Clear Form', ops.clearForm)} />
      <Row icon="check" title="Flatten form fields" detail="Makes the filled values part of the page" onClick={() => actions.edit('Flatten Form', ops.flattenForms)} />
    </>
  );
}

function OrganizePanel() {
  const i = pageIndex.value;
  return (
    <>
      <Row icon="grid" title={organizing.value ? 'Back to document' : 'Open page grid'} onClick={() => (organizing.value = !organizing.value)} />
      <H>Current page</H>
      <div class="chips">
        <button class="glass-btn" onClick={() => actions.edit('Rotate', (d) => ops.rotatePages(d, [i], -90))}><Icon name="rotccw" /> Left</button>
        <button class="glass-btn" onClick={() => actions.edit('Rotate', (d) => ops.rotatePages(d, [i], 90))}><Icon name="rotcw" /> Right</button>
        <button class="glass-btn" onClick={() => actions.edit('Delete Page', (d) => ops.deletePages(d, [i]))}><Icon name="trash" /> Delete</button>
      </div>
      <Row icon="plus" title="Insert blank page" onClick={() => actions.edit('Insert Page', (d) => ops.insertBlank(d, i))} />
      <Row icon="combine" title="Insert from file…" onClick={() => actions.insertFromFiles(i)} />
      <Row icon="copy" title="Duplicate page" onClick={() => actions.edit('Duplicate', (d) => ops.duplicate(d, [i]))} />
      <Row icon="replace" title="Replace page…" detail="With a page of another PDF" onClick={actions.replaceCurrentPage} />
      <H>Document</H>
      <Row icon="output" title="Extract pages…" onClick={async () => {
        const n = active.value?.js?.numPages ?? 1;
        const r = await (await import('../app/store')).prompt('Extract pages', `${i + 1}`, 'Pages, e.g. 1-3, 6');
        const pages = r ? ops.parseRanges(r, n) : null;
        if (pages) await actions.extractPagesTo(pages);
      }} />
      <Row icon="scissors" title="Split document…" onClick={() => (dialog.value = { kind: 'split' })} />
      <Row icon="bookmark" title="Split by bookmarks" detail="One file per top-level bookmark" onClick={actions.splitByBookmarks} />
      <Row icon="combine" title="Combine with other files…" onClick={() => actions.insertFromFiles((active.value?.js?.numPages ?? 1) - 1)} />
      <Row icon="reverse" title="Reverse page order" onClick={() => actions.edit('Reverse', (d) => ops.reorder(d, d.getPageIndices().reverse()))} />
      <Row icon="crop" title="Crop pages" detail="Drag a box on the page" onClick={() => (tool.value = 'crop')} />
    </>
  );
}

/** The document's form fields, each with rename and delete. */
function FieldList() {
  const d = active.value;
  const [fields, setFields] = useState<FieldInfo[]>([]);
  useEffect(() => { if (d) void d.library().then((doc) => setFields(listFields(doc))); }, [d, d?.version.value]);
  if (!fields.length) return null;
  return (
    <>
      <H>{`${fields.length} field${fields.length === 1 ? '' : 's'}`}</H>
      <div class="field-list">
        {fields.map((f) => (
          <div class="field-row" key={f.name}>
            <span class="field-name" title={f.kind}>{f.name}</span>
            <button class="icon-btn" title="Rename" onClick={() => actions.renameFieldNamed(f.name)}><Icon name="rename" /></button>
            <button class="icon-btn" title="Delete field" onClick={() => actions.deleteFieldNamed(f.name)}><Icon name="trash" /></button>
          </div>
        ))}
      </div>
    </>
  );
}

function FormsPanel() {
  return (
    <>
      <p class="hint">Choose a field type and drag on the page.</p>
      <Tools tools={['select', 'textField', 'checkbox', 'dropdown']} />
      <FieldList />
      <Row icon="eraser" title="Clear form" onClick={() => actions.edit('Clear Form', ops.clearForm)} />
      <Row icon="layers" title="Flatten form" onClick={() => actions.edit('Flatten Form', ops.flattenForms)} />
    </>
  );
}

function RedactPanel() {
  const [q, setQ] = useState('');
  const [whole, setWhole] = useState(false);
  return (
    <>
      <p class="hint">Mark what to remove, then apply. Applying permanently deletes the marked text and images.</p>
      <Tools tools={['select', 'redact']} />
      <H>Find and redact</H>
      <input class="field" value={q} placeholder="Text, email, number…" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <label class="check"><input type="checkbox" checked={whole} onChange={(e) => setWhole((e.target as HTMLInputElement).checked)} /> Whole words only</label>
      <button class="glass-btn" disabled={!q} onClick={async () => { const n = await actions.markMatches(q, whole); showToast(n ? `Marked ${n} matches` : `No matches for “${q}”`); }}>Mark all matches</button>
      <H>Apply</H>
      <button class="glass-btn danger" onClick={actions.applyRedactions}>Apply redactions</button>
      <button class="glass-btn" onClick={() => actions.edit('Remove Marks', (d) => {
        for (const a of annots.listAnnots(d).filter(annots.isRedaction).sort((x, y) => y.page - x.page || y.index - x.index)) annots.deleteAnnot(d, a);
      })}>Remove all marks</button>
      <Row icon="info" title="Remove metadata" detail="Title, author, keywords" onClick={() => actions.edit('Remove Metadata', ops.removeMetadata)} />
    </>
  );
}

function ProtectPanel() {
  const d = active.value;
  const [pw, setPw] = useState(''), [pw2, setPw2] = useState(''), [restrict, setRestrict] = useState(false), [owner, setOwner] = useState('');
  const [perm, setPerm] = useState({ print: true, copy: false, modify: false, annotate: true });
  if (!d) return null;
  return (
    <>
      <p class="muted"><Icon name="lock" size={14} /> {d.protection ? (d.protection.user ? 'Password to open' : 'Editing restricted') : 'Not protected'}</p>
      <H>Require a password to open</H>
      <input class="field" type="password" placeholder="Password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
      <input class="field" type="password" placeholder="Confirm password" value={pw2} onInput={(e) => setPw2((e.target as HTMLInputElement).value)} />
      <H>Restrict editing</H>
      <label class="check"><input type="checkbox" checked={restrict} onChange={(e) => setRestrict((e.target as HTMLInputElement).checked)} /> Restrict printing, copying and editing</label>
      {restrict && <>
        <input class="field" type="password" placeholder="Permissions password" value={owner} onInput={(e) => setOwner((e.target as HTMLInputElement).value)} />
        {(['print', 'copy', 'modify', 'annotate'] as const).map((k) => (
          <label class="check" key={k}><input type="checkbox" checked={perm[k]} onChange={(e) => setPerm({ ...perm, [k]: (e.target as HTMLInputElement).checked })} /> Allow {k === 'modify' ? 'page changes' : k === 'annotate' ? 'comments and forms' : k === 'copy' ? 'copying text and images' : 'printing'}</label>
        ))}
      </>}
      <button class="glass-btn prominent" disabled={!pw && !restrict} onClick={() => {
        if (pw !== pw2) return showToast("Passwords don't match");
        if (restrict && !owner) return showToast('Enter a permissions password');
        d.protection = { user: pw || undefined, owner: restrict ? owner : pw || crypto.randomUUID(), ...(restrict ? perm : { print: true, copy: true, modify: true, annotate: true }) };
        d.dirty.value = true;
        setPw(''); setPw2('');
        showToast('Protection is applied when you save (AES-256).');
      }}>Apply protection</button>
      {d.protection && <button class="glass-btn danger" onClick={() => { d.protection = undefined; d.dirty.value = true; showToast('Protection removed. Save to keep the change.'); }}>Remove protection</button>}
    </>
  );
}

function OcrPanel() {
  const [all, setAll] = useState(true), [lang, setLang] = useState('eng+ara'), [skip, setSkip] = useState(true);
  return (
    <>
      <p class="hint">Recognize text in scanned pages so you can search, select and copy it. Works offline.</p>
      <label>Pages <select value={String(all)} onChange={(e) => setAll((e.target as HTMLSelectElement).value === 'true')}><option value="true">All pages</option><option value="false">Current page</option></select></label>
      <label>Language <select value={lang} onChange={(e) => setLang((e.target as HTMLSelectElement).value)}>
        <option value="eng+ara">English + Arabic</option><option value="eng">English</option><option value="ara">Arabic</option>
      </select></label>
      <label class="check"><input type="checkbox" checked={skip} onChange={(e) => setSkip((e.target as HTMLInputElement).checked)} /> Skip pages that already have text</label>
      <button class="glass-btn prominent" onClick={() => actions.runOcr(all ? null : [pageIndex.value], lang, skip)}>Recognize text</button>
      <H>Scan</H>
      <Row icon="camera" title={platform.mobile ? 'Scan with camera' : 'Images to PDF…'} onClick={() => actions.imagesToPdf(platform.mobile)} />
    </>
  );
}

function CompressPanel() {
  const [preset, setPreset] = useState<Preset>('balanced');
  const [estimate, setEstimate] = useState<string | null>(null);
  return (
    <>
      <p class="hint">Reduce the file size for sharing and email.</p>
      {PRESETS.map((p) => (
        <label class="radio" key={p.id}><input type="radio" name="preset" checked={preset === p.id} onChange={() => setPreset(p.id)} />
          <span><b>{p.title}</b><small>{p.detail}</small></span></label>
      ))}
      <button class="glass-btn" onClick={async () => {
        const r = await actions.estimateCompression(preset);
        const mb = (n: number) => `${(n / 1_048_576).toFixed(2)} MB`;
        setEstimate(r ? `${mb(r.before)} now → about ${mb(r.after)} (${Math.round((1 - r.after / r.before) * 100)}% smaller)` : null);
      }}>Check size</button>
      {estimate && <p class="hint">{estimate}</p>}
      <button class="glass-btn prominent" onClick={() => actions.compressActive(preset)}>Compress</button>
    </>
  );
}

function ExportPanel() {
  const [ocr, setOcr] = useState(true), [dpi, setDpi] = useState(150), [q, setQ] = useState(0.9);
  return (
    <>
      <p class="hint">Layout, fonts, colours, tables and images are rebuilt from the page.</p>
      <label class="check"><input type="checkbox" checked={ocr} onChange={(e) => setOcr((e.target as HTMLInputElement).checked)} /> Recognize text in scanned pages (OCR)</label>
      {DOC_FORMATS.map((f) => <Row key={f.id} icon="output" title={f.title} detail={f.detail} onClick={() => actions.exportAs(f.id, ocr && f.id !== 'pptx' && f.id !== 'html')} />)}
      <H>Images</H>
      <label>Resolution <select value={dpi} onChange={(e) => setDpi(Number((e.target as HTMLSelectElement).value))}>{[72, 150, 300, 600].map((d) => <option key={d} value={d}>{d} dpi</option>)}</select></label>
      <label>Quality <input type="range" min="0.3" max="1" step="0.05" value={q} onInput={(e) => setQ(Number((e.target as HTMLInputElement).value))} /> <span>{Math.round(q * 100)}%</span></label>
      <div class="chips">{(['png', 'jpeg', 'webp'] as const).map((t) => <button key={t} class="glass-btn" onClick={() => actions.exportPageImages(t, dpi, q)}>{t.toUpperCase()}</button>)}</div>
      <Row icon="image" title="Extract embedded images" detail="Original JPEGs are saved unchanged" onClick={actions.extractImages} />
      <H>PDF</H>
      <Row icon="output" title="Selected pages as PDF…" onClick={async () => {
        const n = active.value?.js?.numPages ?? 1;
        const r = await (await import('../app/store')).prompt('Selected pages as PDF', `1-${n}`, 'Pages, e.g. 1-3, 6');
        const pages = r ? ops.parseRanges(r, n) : null;
        if (pages) await actions.extractPagesTo(pages);
      }} />
      <Row icon="print" title="Flattened PDF (print-ready)" detail="Comments and form fields merged into the pages" onClick={() => actions.savePdfVariant('flattened')} />
      <Row icon="gray" title="Grayscale PDF" detail="Text stays selectable" onClick={() => actions.savePdfVariant('grayscale')} />
      <Row icon="filetype" title="PDF/X-3 for print" onClick={() => actions.savePdfVariant('pdfx')} />
      <H>Other</H>
      <Row icon="imageminus" title="Remove all images" onClick={() => { if (confirm('Remove all images from every page?')) void actions.edit('Remove Images', editing.removeAllImages); }} />
    </>
  );
}

/** On-device translation (iPhone). */
function Translate() {
  const [to, setTo] = useState('en');
  return (
    <>
      <H>Translate</H>
      <label>Into <select value={to} onChange={(e) => setTo((e.target as HTMLSelectElement).value)}>
        {actions.LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
      </select></label>
      <Row icon="speak" title="Translate document" detail="On this device, with Apple's translator" onClick={() => actions.translateDocument(to)} />
    </>
  );
}

const LAYOUTS: { id: Layout; title: string }[] = [
  { id: 'continuous', title: 'Continuous' }, { id: 'single', title: 'Single page' }, { id: 'two', title: 'Two pages' }, { id: 'twoCover', title: 'Two pages, cover first' },
];

function MorePanel() {
  return (
    <>
      <H>View</H>
      <label>Layout <select value={layout.value} onChange={(e) => (layout.value = (e.target as HTMLSelectElement).value as Layout)}>
        {LAYOUTS.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
      </select></label>
      <label class="check"><input type="checkbox" checked={rightToLeft.value} onChange={(e) => (rightToLeft.value = (e.target as HTMLInputElement).checked)} /> Right-to-left two-page reading</label>
      <label class="check"><input type="checkbox" checked={nightMode.value} onChange={(e) => (nightMode.value = (e.target as HTMLInputElement).checked)} /> Night reading mode</label>
      <Row icon="read" title="Read mode (full screen)" onClick={actions.enterReadMode} />
      <Row icon="speak" title="Read aloud" detail="From this page (choose again to stop)" onClick={actions.readAloud} />
      <Row icon="bookmark" title="Add bookmark for this page…" onClick={actions.addBookmarkHere} />
      {platform.translate && <Translate />}
      <H>Document</H>
      <Row icon="info" title="Document properties…" onClick={() => (dialog.value = { kind: 'properties' })} />
      <Row icon="compare" title="Compare with another PDF…" onClick={() => (dialog.value = { kind: 'compare' })} />
      <Row icon="combine" title="Combine files…" onClick={() => actions.combineFiles()} />
      <Row icon="repair" title="Repair a damaged PDF…" onClick={actions.repairFile} />
      <Row icon="batch" title="Batch process files…" detail="Compress, OCR, number, watermark, protect or convert many PDFs" onClick={() => (dialog.value = { kind: 'batch' })} />
      {platform.print && <Row icon="print" title="Print…" onClick={actions.printActive} />}
      {platform.share && <Row icon="share" title="Share…" onClick={actions.shareActive} />}
      {platform.kind !== 'web' && <Row icon="refresh" title="Check for updates" detail={`You have MK PDF ${platform.version}`} onClick={() => void import('./Update').then((u) => u.checkForUpdates(true))} />}
    </>
  );
}

export function ToolsPanel() {
  const p = panel.value;
  return (
    <aside class="panel glass">
      <button class="panel-grabber" title="Close tools" onClick={() => (showPanel.value = false)}><span /></button>
      <div class="panel-tabs">
        {PANELS.map((x) => (
          <button key={x.id} class={`panel-tab glass-btn ${p === x.id ? 'on' : ''}`} title={x.title} onClick={() => { panel.value = x.id; organizing.value = x.id === 'organize' ? organizing.value || true : false; }}>
            <Icon name={x.icon} /><span>{x.title}</span>
          </button>
        ))}
      </div>
      <div class="panel-body">
        <SelectedAnnotation key={selectedAnnot.value ? `${selectedAnnot.value.page}:${selectedAnnot.value.index}` : 'none'} />
        <h3>{PANELS.find((x) => x.id === p)!.title}</h3>
        {p === 'edit' && <EditPanel />}
        {p === 'comment' && <CommentPanel />}
        {p === 'sign' && <SignPanel />}
        {p === 'organize' && <OrganizePanel />}
        {p === 'forms' && <FormsPanel />}
        {p === 'redact' && <RedactPanel />}
        {p === 'protect' && <ProtectPanel />}
        {p === 'ocr' && <OcrPanel />}
        {p === 'compress' && <CompressPanel />}
        {p === 'export' && <ExportPanel />}
        {p === 'more' && <MorePanel />}
      </div>
    </aside>
  );
}
