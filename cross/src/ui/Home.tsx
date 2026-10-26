import { clearRecents, dialog, openDocument, recents, showToast } from '../app/store';
import * as actions from '../app/actions';
import { platform } from '../app/platform';
import { Icon } from './icons';

export function Home() {
  const tiles: { title: string; detail: string; icon: string; tint: string; run: () => void }[] = [
    { title: 'Open', detail: 'Open a PDF to view and edit', icon: 'open', tint: '#2f7cf6', run: actions.openFiles },
    { title: 'Create Blank', detail: 'Start a new empty PDF', icon: 'new', tint: '#5b5ce6', run: actions.createBlank },
    { title: 'Combine Files', detail: 'Merge PDFs and images', icon: 'combine', tint: '#a259f0', run: () => actions.combineFiles() },
    { title: 'Images to PDF', detail: 'Photos and scans to one PDF', icon: 'images', tint: '#f08a24', run: () => actions.imagesToPdf(false) },
    ...(platform.kind === 'android' ? [{ title: 'Scan', detail: 'Use the camera to scan paper', icon: 'camera', tint: '#1fb58f', run: () => actions.imagesToPdf(true) }] : []),
    { title: 'Compare Files', detail: 'Find differences between two PDFs', icon: 'compare', tint: '#e94b7a', run: () => (dialog.value = { kind: 'compare' }) },
    { title: 'Repair PDF', detail: 'Recover a damaged file', icon: 'repair', tint: '#7a7f8c', run: actions.repairFile },
  ];
  return (
    <div class="home">
      <div class="home-main">
        <div class="brand">
          <img src="icon.png" alt="" width={48} height={48} />
          <div><h1>MK PDF</h1><p class="muted">View, edit, sign and convert PDFs</p></div>
        </div>
        <div class="tiles">
          {tiles.map((t) => (
            <button key={t.title} class="tile glass" onClick={t.run}>
              <span class="tile-icon" style={{ color: t.tint }}><Icon name={t.icon} size={24} /></span>
              <b>{t.title}</b>
              <small>{t.detail}</small>
            </button>
          ))}
        </div>
        <p class="muted drop-hint">…or drop PDF files anywhere in this window.</p>
      </div>
      <aside class="recents glass">
        <div class="recents-head"><b>Recent</b>{recents.value.length > 0 && <button class="link" onClick={clearRecents}>Clear</button>}</div>
        {!recents.value.length && <p class="muted">Files you open appear here.</p>}
        {recents.value.map((r) => (
          <button key={r.path ?? r.name} class="recent" disabled={!r.path} title={r.path ?? 'Open it again from your files'}
            onClick={async () => {
              if (!r.path || !platform.reopen) return;
              const f = await platform.reopen(r.path).catch(() => null);
              if (f) await openDocument(f); else showToast('That file has moved or been deleted.');
            }}>
            <Icon name="new" size={16} /><span>{r.name}</span>
            {r.path && <small class="muted">{r.path.replace(/[\\/][^\\/]+$/, '')}</small>}
          </button>
        ))}
      </aside>
    </div>
  );
}
