// What differs between Windows (Electron shell), Android and iPhone (Capacitor shells) and a plain browser.
export interface OpenedFile { name: string; bytes: Uint8Array; path?: string }

export interface Platform {
  kind: 'windows' | 'android' | 'ios' | 'web';
  /** A phone or tablet (Android or iPhone): camera scanning, sheets instead of side panels. */
  mobile: boolean;
  version: string;
  openFiles(accept: string, multiple: boolean, capture?: boolean): Promise<OpenedFile[]>;
  /** Saves bytes; returns a description of where it went, or null if cancelled. */
  saveFile(name: string, bytes: Uint8Array, mime: string, path?: string, saveAs?: boolean): Promise<{ path?: string; label: string } | null>;
  saveMany(files: { name: string; bytes: Uint8Array }[], mime: string): Promise<string | null>;
  share?(name: string, bytes: Uint8Array, mime: string): Promise<void>;
  print?(bytes: Uint8Array): Promise<void>;
  systemFont?(family: string, bold: boolean, italic: boolean): Promise<Uint8Array | null>;
  onOpenFile(cb: (f: OpenedFile) => void): void;
  /** Reopens a recent file by path (Windows). */
  reopen?(path: string): Promise<OpenedFile | null>;
  openExternal(url: string): void;
  installUpdate(url: string, name: string): Promise<void>;
  notify(title: string, body: string): void;
  confirmClose?(hasUnsaved: () => boolean): void;
  /** Reads text aloud with the system voice; `done` is called when it finishes or is stopped. */
  speak(text: string, done: () => void): Promise<void>;
  stopSpeaking(): void;
  /** On-device translation (iPhone, iOS 18 or later, with Apple's translator). */
  translate?(paragraphs: string[], target: string): Promise<string[]>;
  /** Opens the folder files are saved to (iPhone: MK PDF in the Files app). */
  showFolder?(): void;
}

/** The browser engine's speech (Windows' voices in Electron, iPhone's in WebKit). */
const webSpeech = {
  async speak(text: string, done: () => void) {
    if (!('speechSynthesis' in window)) { done(); throw new Error('Reading aloud isn’t available here.'); }
    speechSynthesis.cancel();
    // Long text is spoken in sentence-sized pieces (some engines stop after a few minutes of one utterance).
    const parts = text.match(/[^.!?\n]{1,300}[.!?\n]?/g) ?? [text];
    const lang = /[\u0600-\u06ff]/.test(text) ? 'ar' : undefined;
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p);
      if (lang) u.lang = lang;
      if (i === parts.length - 1) { u.onend = done; u.onerror = done; }
      speechSynthesis.speak(u);
    });
  },
  stopSpeaking() { if ('speechSynthesis' in window) speechSynthesis.cancel(); },
};

interface DesktopBridge {
  version: string;
  openDialog(accept: string, multiple: boolean): Promise<{ name: string; path: string; data: ArrayBuffer }[]>;
  readFile(path: string): Promise<{ name: string; path: string; data: ArrayBuffer } | null>;
  save(name: string, data: ArrayBuffer, path?: string, saveAs?: boolean): Promise<string | null>;
  saveMany(files: { name: string; data: ArrayBuffer }[]): Promise<string | null>;
  systemFont(family: string, bold: boolean, italic: boolean): Promise<ArrayBuffer | null>;
  print(data: ArrayBuffer): Promise<void>;
  onOpenFile(cb: (f: { name: string; path: string; data: ArrayBuffer }) => void): void;
  openExternal(url: string): void;
  installUpdate(url: string, name: string): Promise<void>;
  setDirty(dirty: boolean): void;
}

declare global {
  interface Window { mkpdf?: DesktopBridge; Capacitor?: { isNativePlatform(): boolean; getPlatform(): string } }
}

const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const APP_VERSION = __APP_VERSION__;

function pickFiles(accept: string, multiple: boolean, capture = false): Promise<OpenedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute('capture', 'environment');
    // Kept in the page until the choice comes back: mobile web views can drop a detached input, and with it the
    // files the user picked.
    input.style.display = 'none';
    document.body.appendChild(input);
    const done = (files: OpenedFile[]) => { input.remove(); resolve(files); };
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      done(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
    };
    input.oncancel = () => done([]);
    input.click();
  });
}

function download(name: string, bytes: Uint8Array, mime: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function notify(title: string, body: string) {
  if (!('Notification' in window)) return;
  const show = () => { try { new Notification(title, { body }); } catch { /* unsupported */ } };
  if (Notification.permission === 'granted') show();
  else if (Notification.permission !== 'denied') Notification.requestPermission().then((p) => p === 'granted' && show());
}

function desktop(b: DesktopBridge): Platform {
  return {
    kind: 'windows', mobile: false, version: b.version || APP_VERSION, ...webSpeech,
    async openFiles(accept, multiple) {
      return (await b.openDialog(accept, multiple)).map((f) => ({ name: f.name, path: f.path, bytes: new Uint8Array(f.data) }));
    },
    async saveFile(name, bytes, _mime, path, saveAs) {
      const p = await b.save(name, buf(bytes), path, saveAs);
      return p ? { path: p, label: p } : null;
    },
    saveMany: (files) => b.saveMany(files.map((f) => ({ name: f.name, data: buf(f.bytes) }))),
    print: (bytes) => b.print(buf(bytes)),
    async systemFont(family, bold, italic) { const d = await b.systemFont(family, bold, italic); return d ? new Uint8Array(d) : null; },
    onOpenFile: (cb) => b.onOpenFile((f) => cb({ name: f.name, path: f.path, bytes: new Uint8Array(f.data) })),
    async reopen(path) { const f = await b.readFile(path); return f ? { name: f.name, path: f.path, bytes: new Uint8Array(f.data) } : null; },
    openExternal: (url) => b.openExternal(url),
    installUpdate: (url, name) => b.installUpdate(url, name),
    notify,
    confirmClose(hasUnsaved) { setInterval(() => b.setDirty(hasUnsaved()), 1000); },
  };
}

/** Android and iPhone: the same Capacitor shell, with each system's own installer, voice and file places. */
async function capacitor(kind: 'android' | 'ios'): Promise<Platform> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');
  const { App } = await import('@capacitor/app');
  const { registerPlugin } = await import('@capacitor/core');
  const OpenFile = registerPlugin<{
    addListener(e: 'open', cb: (f: { name: string; path: string }) => void): Promise<unknown>;
    pick(o: { accept: string; multiple: boolean }): Promise<{ files: { name: string; path: string }[] }>;
    showFolder(): Promise<void>;
  }>('OpenFile');
  const Updater = registerPlugin<{ install(o: { url: string }): Promise<void>; notify(o: { title: string; body: string }): Promise<void> }>('Updater');
  const Translate = registerPlugin<{ available(): Promise<{ available: boolean }>; translate(o: { paragraphs: string[]; target: string }): Promise<{ paragraphs: string[] }> }>('Translate');
  const canTranslate = kind === 'ios' && (await Translate.available().catch(() => ({ available: false }))).available;
  // Android's web view has no speech synthesis; its system text-to-speech engine reads instead.
  const Speech = registerPlugin<{ speak(o: { text: string }): Promise<void>; stop(): Promise<void> }>('Speech');
  const toB64 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const write = async (dir: string, name: string, bytes: Uint8Array, directory: (typeof Directory)[keyof typeof Directory]) => {
    const path = dir ? `${dir}/${name}` : name;
    const r = await Filesystem.writeFile({ path, data: toB64(bytes), directory, recursive: true });
    return { uri: r.uri, path };
  };
  /** Reads a file the native side copied into the app's temporary folder, then deletes the copy. */
  const take = async (d: { name: string; path: string }): Promise<OpenedFile> => {
    const r = await Filesystem.readFile({ path: d.path });
    void Filesystem.deleteFile({ path: d.path }).catch(() => {});
    return { name: d.name, bytes: fromB64(r.data as string) };
  };
  const listeners: ((f: OpenedFile) => void)[] = [];
  const pending: OpenedFile[] = [];
  // The native activity copies files opened with "Open with MK PDF" into the cache and announces them
  // (held natively until this listener exists, so a file that launched the app isn't lost).
  void OpenFile.addListener('open', async (d) => {
    try {
      const f = await take(d);
      if (listeners.length) listeners.forEach((l) => l(f)); else pending.push(f);
    } catch { /* unreadable */ }
  });
  // iPhone: the app's Documents folder is "On My iPhone › MK PDF" in the Files app.
  const place = kind === 'ios' ? 'On My iPhone › MK PDF (Files app)' : 'Documents/MK PDF';
  const folder = kind === 'ios' ? '' : 'MK PDF';
  return {
    kind, mobile: true, version: APP_VERSION,
    async openFiles(accept, multiple, capture) {
      // iPhone documents come from the system's document picker; photos and the camera keep the web view's
      // own chooser, which offers the photo library.
      if (kind !== 'ios' || capture || accept === 'image/*') return pickFiles(accept, multiple, capture);
      const { files } = await OpenFile.pick({ accept, multiple });
      return Promise.all(files.map(take));
    },
    async saveFile(name, bytes) {
      await write(folder, name, bytes, Directory.Documents);
      return { label: kind === 'ios' ? `“${name}” in ${place}` : `${place}/${name}` };
    },
    async saveMany(files) {
      for (const f of files) await write(folder, f.name, f.bytes, Directory.Documents);
      return place;
    },
    async share(name, bytes) {
      const { uri } = await write('share', name, bytes, Directory.Cache);
      await Share.share({ title: name, url: uri, dialogTitle: `Share ${name}` });
    },
    onOpenFile(cb) { listeners.push(cb); pending.splice(0).forEach(cb); },
    ...(kind === 'ios' ? { showFolder: () => { void OpenFile.showFolder().catch(() => {}); } } : {}),
    openExternal: (url) => { window.open(url, '_system'); },
    // Android: downloads the APK and opens the system installer, which updates this app in place. iPhone apps
    // can't install themselves; the release page has the new build to sign and install.
    async installUpdate(url) { if (kind === 'android') await Updater.install({ url }); else window.open(url, '_system'); },
    notify: (title, body) => { if (kind === 'android') void Updater.notify({ title, body }).catch(() => {}); },
    ...(canTranslate ? { translate: async (paragraphs: string[], target: string) => (await Translate.translate({ paragraphs, target })).paragraphs } : {}),
    ...(kind === 'android' ? {
      async speak(text: string, done: () => void) { try { await Speech.speak({ text }); } finally { done(); } },
      stopSpeaking() { void Speech.stop(); },
    } : webSpeech),
    confirmClose() { App.addListener('backButton', ({ canGoBack }) => { if (!canGoBack) App.minimizeApp(); else history.back(); }); },
  };
}

function web(): Platform {
  return {
    kind: 'web', mobile: false, version: APP_VERSION, ...webSpeech,
    openFiles: (accept, multiple, capture) => pickFiles(accept, multiple, capture),
    async saveFile(name, bytes, mime) { download(name, bytes, mime); return { label: 'Downloads' }; },
    async saveMany(files, mime) { files.forEach((f) => download(f.name, f.bytes, mime)); return 'Downloads'; },
    onOpenFile() {},
    openExternal: (url) => { window.open(url, '_blank'); },
    async installUpdate(url) { window.open(url, '_blank'); },
    notify,
  };
}

export let platform: Platform = web();

export async function initPlatform() {
  if (window.mkpdf) platform = desktop(window.mkpdf);
  else if (window.Capacitor?.isNativePlatform?.()) {
    const p = window.Capacitor.getPlatform();
    if (p === 'android' || p === 'ios') platform = await capacitor(p);
  }
  return platform;
}
