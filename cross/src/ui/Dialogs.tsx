import { useEffect, useRef, useState } from 'preact/hooks';
import { active, dialog, placing, showToast, tool } from '../app/store';
import * as actions from '../app/actions';
import * as ops from '../pdf/ops';
import { platform } from '../app/platform';
import { addSignature } from './signatures';
import { Compare } from './Compare';

const close = () => (dialog.value = null);

function Sheet({ title, children, wide }: { title: string; children: preact.ComponentChildren; wide?: boolean }) {
  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class={`sheet glass ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Buttons({ ok, onOk, disabled }: { ok: string; onOk: () => void; disabled?: boolean }) {
  return (
    <div class="sheet-buttons">
      <button class="glass-btn" onClick={close}>Cancel</button>
      <button class="glass-btn prominent" disabled={disabled} onClick={onOk}>{ok}</button>
    </div>
  );
}

function Prompt({ title, label, message, initial = '', secure, resolve }: { title: string; label?: string; message?: string; initial?: string; secure?: boolean; resolve: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const done = (value: string | null) => { close(); resolve(value); };
  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && done(null)}>
      <div class="sheet glass">
        <h2>{title}</h2>
        {message && <p class="muted">{message}</p>}
        <input ref={ref} class="field" {...({ type: secure ? 'password' : 'text' } as Record<string, string>)} placeholder={label} value={v}
          onInput={(e) => setV((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && done(v)} />
        <div class="sheet-buttons">
          <button class="glass-btn" onClick={() => done(null)}>Cancel</button>
          <button class="glass-btn prominent" onClick={() => done(v)}>OK</button>
        </div>
      </div>
    </div>
  );
}

function Choose({ title, options, message, resolve }: { title: string; options: string[]; message?: string; resolve: (v: number | null) => void }) {
  const done = (v: number | null) => { close(); resolve(v); };
  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && done(null)}>
      <div class="sheet glass">
        <h2>{title}</h2>
        {message && <p class="muted">{message}</p>}
        <div class="sheet-buttons stack">
          {options.map((o, i) => <button key={o} class={`glass-btn ${i === options.length - 1 ? 'prominent' : ''}`} onClick={() => done(i)}>{o}</button>)}
          <button class="glass-btn" onClick={() => done(null)}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function SignatureDialog({ kind }: { kind: string }) {
  const [mode, setMode] = useState<'draw' | 'type' | 'image'>('draw');
  const [name, setName] = useState(localStorage.getItem('mkpdf.author') ?? '');
  const [font, setFont] = useState('cursive');
  const [ink, setInk] = useState('#111111');
  const [image, setImage] = useState<Uint8Array | null>(null);
  const pad = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<{ x: number; y: number }[][]>([]);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const c = pad.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio; c.height = c.clientHeight * ratio;
    redraw();
  }, [mode]);
  const redraw = () => {
    const c = pad.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = ink; ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of strokes.current) { ctx.beginPath(); s.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke(); }
  };
  const pos = (e: PointerEvent) => { const r = pad.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  const render = async (): Promise<{ png: Uint8Array; w: number; h: number } | null> => {
    const out = document.createElement('canvas');
    const ctx = out.getContext('2d')!;
    const scale = 3;
    if (mode === 'image') {
      if (!image) return null;
      const bmp = await createImageBitmap(new Blob([image as BlobPart]));
      out.width = bmp.width; out.height = bmp.height;
      ctx.drawImage(bmp, 0, 0);
      return { png: await png(out), w: bmp.width * 0.75, h: bmp.height * 0.75 };
    }
    if (mode === 'type') {
      if (!name.trim()) return null;
      const size = (kind === 'Initials' ? 64 : 54) * scale;
      ctx.font = `${size}px ${font}`;
      const w = ctx.measureText(name).width;
      out.width = w + 20 * scale; out.height = size * 1.4;
      ctx.font = `${size}px ${font}`; ctx.fillStyle = ink; ctx.textBaseline = 'middle';
      ctx.fillText(name, 10 * scale, out.height / 2);
      return { png: await png(out), w: out.width / scale, h: out.height / scale };
    }
    const pts = strokes.current.flat();
    if (pts.length < 3) return null;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs) - 6, y0 = Math.min(...ys) - 6, w = Math.max(...xs) - x0 + 6, h = Math.max(...ys) - y0 + 6;
    out.width = w * scale; out.height = h * scale;
    ctx.scale(scale, scale);
    ctx.strokeStyle = ink; ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of strokes.current) { ctx.beginPath(); s.forEach((p, i) => (i ? ctx.lineTo(p.x - x0, p.y - y0) : ctx.moveTo(p.x - x0, p.y - y0))); ctx.stroke(); }
    return { png: await png(out), w, h };
  };
  const png = (c: HTMLCanvasElement) => new Promise<Uint8Array>((r) => c.toBlob((b) => b!.arrayBuffer().then((a) => r(new Uint8Array(a))), 'image/png'));

  return (
    <Sheet title={kind === 'Initials' ? 'Add Initials' : 'Add Signature'} wide>
      <div class="segmented">
        {(['draw', 'type', 'image'] as const).map((m) => <button key={m} class={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{m[0].toUpperCase() + m.slice(1)}</button>)}
      </div>
      {mode === 'draw' && <>
        <canvas ref={pad} class="sigpad"
          onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); strokes.current.push([pos(e)]); setCount(count + 1); }}
          onPointerMove={(e) => { if (e.buttons !== 1 || !strokes.current.length) return; strokes.current[strokes.current.length - 1].push(pos(e)); redraw(); }} />
        <div class="chips"><button class="glass-btn" onClick={() => { strokes.current = []; redraw(); setCount(0); }}>Clear</button></div>
      </>}
      {mode === 'type' && <>
        <div class="sigpreview" style={{ fontFamily: font, color: ink }}>{name || 'Your name'}</div>
        <input class="field" value={name} placeholder="Name" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <select value={font} onChange={(e) => setFont((e.target as HTMLSelectElement).value)}>
          {['cursive', "'Segoe Script', cursive", "'Brush Script MT', cursive", "'Lucida Handwriting', cursive", "'Dancing Script', cursive", 'serif'].map((f) => <option key={f} value={f}>{f.split(',')[0].replace(/'/g, '')}</option>)}
        </select>
      </>}
      {mode === 'image' && <div class="chips"><button class="glass-btn" onClick={async () => { const [f] = await platform.openFiles('image/*', false); if (f) setImage(f.bytes); }}>{image ? 'Change image…' : 'Choose image…'}</button></div>}
      {mode !== 'image' && <div class="chips">{['#111111', '#1a3a8f', '#8f1a1a'].map((c) => <button key={c} class={`swatch ${ink === c ? 'on' : ''}`} style={{ background: c }} onClick={() => { setInk(c); setTimeout(redraw); }} />)}</div>}
      <Buttons ok="Save and place" onOk={async () => {
        const r = await render();
        if (!r) return showToast(mode === 'draw' ? 'Draw your signature first' : 'Nothing to save yet');
        addSignature(kind, r.png, r.w, r.h);
        placing.value = { ...r, kind };
        tool.value = 'stamp';
        close();
        showToast('Tap the page to place it.');
      }} />
    </Sheet>
  );
}

function WatermarkDialog() {
  const [text, setText] = useState('CONFIDENTIAL'), [image, setImage] = useState<Uint8Array | null>(null), [useImage, setUseImage] = useState(false);
  const [size, setSize] = useState(72), [opacity, setOpacity] = useState(0.18), [angle, setAngle] = useState(45), [col, setCol] = useState('#e53935'), [range, setRange] = useState('');
  return (
    <Sheet title="Watermark">
      <div class="segmented"><button class={!useImage ? 'on' : ''} onClick={() => setUseImage(false)}>Text</button><button class={useImage ? 'on' : ''} onClick={() => setUseImage(true)}>Image</button></div>
      {useImage ? <button class="glass-btn" onClick={async () => { const [f] = await platform.openFiles('image/*', false); if (f) setImage(f.bytes); }}>{image ? 'Change image…' : 'Choose image…'}</button>
        : <input class="field" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />}
      <label>Size <input type="range" min="18" max="160" value={size} onInput={(e) => setSize(Number((e.target as HTMLInputElement).value))} /><span>{size}</span></label>
      <label>Opacity <input type="range" min="0.05" max="1" step="0.05" value={opacity} onInput={(e) => setOpacity(Number((e.target as HTMLInputElement).value))} /><span>{Math.round(opacity * 100)}%</span></label>
      <label>Angle <input type="range" min="-90" max="90" step="5" value={angle} onInput={(e) => setAngle(Number((e.target as HTMLInputElement).value))} /><span>{angle}°</span></label>
      {!useImage && <label>Colour <input type="color" value={col} onInput={(e) => setCol((e.target as HTMLInputElement).value)} /></label>}
      <input class="field" value={range} placeholder="Pages (blank = all), e.g. 1-3, 5" onInput={(e) => setRange((e.target as HTMLInputElement).value)} />
      <Buttons ok="Apply" disabled={useImage ? !image : !text} onOk={async () => {
        const n = active.value?.js?.numPages ?? 0;
        const pages = range.trim() ? ops.parseRanges(range, n) : [...Array(n).keys()];
        if (!pages) return showToast('Check the page range');
        close();
        const rgb = [1, 3, 5].map((i) => parseInt(col.slice(i, i + 2), 16) / 255) as [number, number, number];
        await actions.edit('Watermark', (d) => ops.watermark(d, pages, { text: useImage ? undefined : text, image: useImage ? image! : undefined, size, opacity, angle, color: rgb }));
      }} />
    </Sheet>
  );
}

function HeaderFooterDialog({ bates }: { bates?: boolean }) {
  const [slots, setSlots] = useState(['', '', '', '', '', '']);
  const [size, setSize] = useState(10), [margin, setMargin] = useState(28);
  const [prefix, setPrefix] = useState('MK'), [start, setStart] = useState(1), [digits, setDigits] = useState(6), [slot, setSlot] = useState(5);
  const labels = ['Header left', 'Header centre', 'Header right', 'Footer left', 'Footer centre', 'Footer right'];
  return (
    <Sheet title={bates ? 'Bates Numbering' : 'Header & Footer'}>
      {bates ? <>
        <input class="field" value={prefix} placeholder="Prefix" onInput={(e) => setPrefix((e.target as HTMLInputElement).value)} />
        <label>Start at <input class="field small" type="number" value={start} onInput={(e) => setStart(Number((e.target as HTMLInputElement).value))} /></label>
        <label>Digits <input class="field small" type="number" min="1" max="10" value={digits} onInput={(e) => setDigits(Number((e.target as HTMLInputElement).value))} /></label>
        <label>Position <select value={slot} onChange={(e) => setSlot(Number((e.target as HTMLSelectElement).value))}>{[5, 4, 3, 2].map((s) => <option key={s} value={s}>{labels[s]}</option>)}</select></label>
        <p class="muted">Example: {prefix}{String(start).padStart(digits, '0')}</p>
      </> : <>
        <p class="muted">Use {'{page}'}, {'{pages}'}, {'{date}'} and {'{file}'}.</p>
        {labels.map((l, i) => <input key={l} class="field" placeholder={i === 4 ? 'Page {page} of {pages}' : l} value={slots[i]} onInput={(e) => { const n = [...slots]; n[i] = (e.target as HTMLInputElement).value; setSlots(n); }} />)}
      </>}
      <label>Font size <input type="range" min="6" max="24" value={size} onInput={(e) => setSize(Number((e.target as HTMLInputElement).value))} /><span>{size}</span></label>
      <label>Margin <input type="range" min="10" max="72" value={margin} onInput={(e) => setMargin(Number((e.target as HTMLInputElement).value))} /><span>{margin}</span></label>
      <Buttons ok="Apply" onOk={async () => {
        close();
        const used = bates ? ['', '', '', '', '', ''] : slots.every((s) => !s) ? ['', '', '', '', 'Page {page} of {pages}', ''] : slots;
        const file = active.value?.name.replace(/\.pdf$/i, '') ?? '';
        await actions.edit(bates ? 'Bates Numbering' : 'Header & Footer', (d) => ops.headerFooter(d, used, { size, margin, file, bates: bates ? { prefix, start, digits, slot } : undefined }));
      }} />
    </Sheet>
  );
}

function SplitDialog() {
  const [mode, setMode] = useState<'every' | 'ranges' | 'parts' | 'size'>('every');
  const [value, setValue] = useState('1'), [merge, setMerge] = useState(false);
  const hints = { every: 'Pages per file', ranges: 'Ranges, e.g. 1-3; 4-8; 9-', parts: 'Number of files', size: 'Maximum MB per file' };
  return (
    <Sheet title="Split Document">
      <label>Split by <select value={mode} onChange={(e) => { const m = (e.target as HTMLSelectElement).value as typeof mode; setMode(m); setValue(m === 'every' ? '1' : m === 'parts' ? '2' : m === 'size' ? '5' : ''); }}>
        <option value="every">Number of pages</option><option value="ranges">Page ranges</option><option value="parts">Number of files</option><option value="size">File size</option>
      </select></label>
      <input class="field" value={value} placeholder={hints[mode]} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
      {mode === 'ranges' && <label class="check"><input type="checkbox" checked={merge} onChange={(e) => setMerge((e.target as HTMLInputElement).checked)} /> Merge all ranges into one PDF</label>}
      <Buttons ok="Split" onOk={() => { close(); void actions.splitActive(mode, value, merge); }} />
    </Sheet>
  );
}

/** One operation on many PDFs, saved together (like the Mac app's batch tool). */
function BatchDialog() {
  const [files, setFiles] = useState<{ name: string; bytes: Uint8Array }[]>([]);
  const [op, setOp] = useState<actions.BatchOp>('compress');
  const [value, setValue] = useState('');
  const info = actions.BATCH_OPS.find((o) => o.id === op)!;
  return (
    <Sheet title="Batch Process Files">
      <button class="glass-btn" onClick={async () => { const more = await platform.openFiles('application/pdf,.pdf', true); setFiles([...files, ...more]); }}>Add PDFs…</button>
      {files.length > 0 && <ul class="batch-files">{files.map((f, i) => <li key={`${f.name}-${i}`}>{f.name}
        <button class="icon-btn" title="Remove" onClick={() => setFiles(files.filter((_, k) => k !== i))}>✕</button></li>)}</ul>}
      <label>Operation <select value={op} onChange={(e) => { setOp((e.target as HTMLSelectElement).value as actions.BatchOp); setValue(''); }}>
        {actions.BATCH_OPS.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
      </select></label>
      {info.input && (op === 'password'
        ? <input class="field" type="password" value={value} placeholder={info.input} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
        : <input class="field" value={value} placeholder={info.input} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />)}
      <Buttons ok={`Process ${files.length || ''} file${files.length === 1 ? '' : 's'}`} onOk={() => {
        if (!files.length) return showToast('Add PDFs to process first.');
        if (info.input && !value) return showToast(`Enter the ${info.input.toLowerCase()}.`);
        close();
        void actions.runBatch(files, op, value);
      }} />
    </Sheet>
  );
}

function TranslationDialog({ text, name }: { text: string; name: string }) {
  return (
    <Sheet title="Translation" wide>
      <textarea class="field translation" readOnly value={text} />
      <div class="buttons">
        <button class="glass-btn" onClick={() => { void navigator.clipboard?.writeText(text); showToast('Copied'); }}>Copy</button>
        <button class="glass-btn" onClick={async () => { const r = await platform.saveFile(`${name} (translated).txt`, new TextEncoder().encode(text), 'text/plain'); if (r) showToast(`Saved to ${r.label}`); }}>Save as text</button>
        <button class="glass-btn prominent" onClick={close}>Done</button>
      </div>
    </Sheet>
  );
}

function PropertiesDialog() {
  const d = active.value;
  const [m, setM] = useState({ title: '', author: '', subject: '', keywords: '' });
  const [info, setInfo] = useState<Record<string, string>>({});
  useEffect(() => {
    void d?.library().then((doc) => {
      setM({ title: doc.getTitle() ?? '', author: doc.getAuthor() ?? '', subject: doc.getSubject() ?? '', keywords: doc.getKeywords() ?? '' });
      const p = doc.getPage(0);
      setInfo({
        Pages: String(doc.getPageCount()), 'Page size': `${(p.getWidth() / 72).toFixed(1)} × ${(p.getHeight() / 72).toFixed(1)} in`,
        Creator: doc.getCreator() ?? '—', Producer: doc.getProducer() ?? '—', Created: doc.getCreationDate()?.toLocaleString() ?? '—',
        Modified: doc.getModificationDate()?.toLocaleString() ?? '—', 'File size': `${(d.bytes.length / 1_048_576).toFixed(2)} MB`,
        Security: d.protection ? 'Password protected' : 'None',
      });
    });
  }, []);
  return (
    <Sheet title="Document Properties">
      {(['title', 'author', 'subject', 'keywords'] as const).map((k) => <input key={k} class="field" placeholder={k[0].toUpperCase() + k.slice(1)} value={m[k]} onInput={(e) => setM({ ...m, [k]: (e.target as HTMLInputElement).value })} />)}
      <dl class="info">{Object.entries(info).map(([k, v]) => <><dt>{k}</dt><dd>{v}</dd></>)}</dl>
      <Buttons ok="Save" onOk={() => { close(); void actions.edit('Properties', (doc) => ops.setMetadata(doc, m)); }} />
    </Sheet>
  );
}

export function Dialogs() {
  const dlg = dialog.value;
  if (!dlg) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (dlg.props ?? {}) as any;
  switch (dlg.kind) {
    case 'prompt': return <Prompt {...p} />;
    case 'choose': return <Choose {...p} />;
    case 'signature': return <SignatureDialog {...p} />;
    case 'watermark': return <WatermarkDialog />;
    case 'headerFooter': return <HeaderFooterDialog />;
    case 'bates': return <HeaderFooterDialog bates />;
    case 'split': return <SplitDialog />;
    case 'batch': return <BatchDialog />;
    case 'translation': return <TranslationDialog {...(p as { text: string; name: string })} />;
    case 'properties': return <PropertiesDialog />;
    case 'compare': return <Compare onClose={close} />;
    default: return null;
  }
}
