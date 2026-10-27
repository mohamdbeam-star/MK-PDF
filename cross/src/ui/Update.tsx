import { signal } from '@preact/signals';
import { platform } from '../app/platform';
import { showToast } from '../app/store';

interface Release { version: string; page: string; asset: string; name: string; notes: string }
export const update = signal<Release | null>(null);
const REPO = 'mohamdbeam-star/MK-PDF';

export function isNewer(a: string, b: string) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y; }
  return false;
}

/** Looks for the newest release carrying this platform's installer. */
let lastCheck = 0;
export async function checkForUpdates(userInitiated = false) {
  if (platform.kind === 'web') return;
  lastCheck = Date.now();
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=15`, { headers: { Accept: 'application/vnd.github+json' } });
    const list = (await r.json()) as { tag_name: string; html_url: string; body: string; draft: boolean; prerelease: boolean; assets: { name: string; browser_download_url: string }[] }[];
    const want = platform.kind === 'windows' ? (n: string) => /win-x64\.exe$/i.test(n) : (n: string) => /\.apk$/i.test(n);
    const best = list.filter((x) => !x.draft && !x.prerelease)
      .map((x) => ({ x, asset: x.assets.find((a) => want(a.name)) }))
      .filter((c) => c.asset)
      .map((c) => ({ version: c.x.tag_name.replace(/^v/, ''), page: c.x.html_url, asset: c.asset!.browser_download_url, name: c.asset!.name, notes: c.x.body }))
      .sort((a, b) => (isNewer(a.version, b.version) ? -1 : 1))[0];
    if (best && isNewer(best.version, platform.version) && localStorage.getItem('mkpdf.skip') !== best.version) {
      const fresh = update.value?.version !== best.version;
      update.value = best;
      if (fresh) platform.notify(`MK PDF ${best.version} is available`, `You have ${platform.version}. Open MK PDF to update.`);
    } else if (userInitiated) showToast(`MK PDF ${platform.version} is up to date.`);
  } catch {
    if (userInitiated) showToast("Couldn't check for updates.");
  }
}

/** Checks shortly after launch, every hour, and whenever the app comes back to the front (at most every 15 minutes). */
export function startUpdateChecks() {
  setTimeout(() => checkForUpdates(false), 4000);
  setInterval(() => checkForUpdates(false), 3600 * 1000);
  const soon = () => { if (document.visibilityState === 'visible' && Date.now() - lastCheck > 15 * 60 * 1000) void checkForUpdates(false); };
  document.addEventListener('visibilitychange', soon);
  window.addEventListener('focus', soon);
}

export function UpdateBanner() {
  const u = update.value;
  if (!u) return null;
  return (
    <div class="update glass">
      <b>MK PDF {u.version} is available</b><span class="muted">You have {platform.version}</span>
      <span class="grow" />
      <button class="link" onClick={() => platform.openExternal(u.page)}>What's new</button>
      <button class="glass-btn prominent small" onClick={async () => {
        showToast('Downloading the update…');
        try { await platform.installUpdate(u.asset, u.name); } catch (e) { showToast(e instanceof Error ? e.message : String(e)); }
      }}>
        {platform.kind === 'android' ? 'Install' : 'Download & Install'}
      </button>
      <button class="icon-btn" title="Skip this version" onClick={() => { localStorage.setItem('mkpdf.skip', u.version); update.value = null; }}>✕</button>
    </div>
  );
}
