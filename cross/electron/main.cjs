// MK PDF for Windows: an Electron shell around the web app in ../dist. Installs per user (no admin rights).
const { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, Menu } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
let win = null;
let dirty = false;
let listening = false; // the page has asked for files (so it receives open-file events)
const queued = []; // files opened before the page was listening

// The app is served from app://mkpdf/ so module workers, WebAssembly and fetch() of bundled fonts all work.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();

const pdfArgs = (argv) => argv.slice(1).filter((a) => /\.pdf$/i.test(a) && fs.existsSync(a));
const fileInfo = (p) => { const b = fs.readFileSync(p); return { name: path.basename(p), path: p, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };

function openPaths(paths) {
  for (const p of paths) {
    try {
      if (win && listening) win.webContents.send('open-file', fileInfo(p)); else queued.push(p);
    } catch { /* unreadable file */ }
  }
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
}

app.on('second-instance', (_e, argv) => openPaths(pdfArgs(argv)));

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 720, minHeight: 520,
    title: 'MK PDF',
    icon: path.join(DIST, 'icon.png'),
    backgroundColor: '#00000000',
    backgroundMaterial: 'mica', // Windows 11 glass behind the app's own translucent panels
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  Menu.setApplicationMenu(null);
  win.loadURL('app://mkpdf/index.html');
  win.webContents.on('did-start-loading', () => { listening = false; });
  // MKPDF_SMOKE=1: report what loaded (home screen, bridge, opened tabs, console errors) and quit. Used by CI.
  if (process.env.MKPDF_SMOKE) {
    const errors = [];
    win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
    win.webContents.on('did-finish-load', () => setTimeout(async () => {
      const state = await win.webContents.executeJavaScript(`({ app: !!document.querySelector('.app'), bridge: !!window.mkpdf, version: window.mkpdf && window.mkpdf.version, tabs: [...document.querySelectorAll('.tab-name')].map((t) => t.textContent) })`);
      const line = 'SMOKE ' + JSON.stringify({ ...state, errors });
      console.log(line);
      if (process.env.MKPDF_SMOKE_OUT) fs.writeFileSync(process.env.MKPDF_SMOKE_OUT, line);
      dirty = false;
      app.exit(state.app && state.bridge && !errors.length ? 0 : 1);
    }, Number(process.env.MKPDF_SMOKE_WAIT || 4000)));
  }
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (!dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Quit without saving', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'You have unsaved changes.', detail: 'Quit MK PDF anyway?',
    });
    if (choice !== 0) e.preventDefault();
  });
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  queued.push(...pdfArgs(process.argv));
  createWindow();
});
app.on('window-all-closed', () => app.quit());

// --- Bridge (see preload.cjs and src/app/platform.ts) ---

ipcMain.on('version', (e) => { e.returnValue = app.getVersion(); });
ipcMain.handle('pending-files', () => {
  listening = true;
  return queued.splice(0).flatMap((p) => { try { return [fileInfo(p)]; } catch { return []; } });
});

const filtersFor = (accept) => {
  const a = accept.toLowerCase();
  const filters = [];
  if (a.includes('pdf')) filters.push({ name: 'PDF documents', extensions: ['pdf'] });
  if (a.includes('image')) filters.push({ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'] });
  const exts = (accept.match(/\.([a-z0-9]+)/gi) ?? []).map((x) => x.slice(1)).filter((x) => x !== 'pdf');
  if (exts.length) filters.push({ name: 'Files', extensions: exts });
  filters.push({ name: 'All files', extensions: ['*'] });
  return filters;
};

ipcMain.handle('open-dialog', async (_e, accept, multiple) => {
  const r = await dialog.showOpenDialog(win, { properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'], filters: filtersFor(accept) });
  return r.canceled ? [] : r.filePaths.map(fileInfo);
});

ipcMain.handle('read-file', async (_e, p) => { try { return fileInfo(p); } catch { return null; } });

ipcMain.handle('save', async (_e, name, data, existing, saveAs) => {
  let target = existing && !saveAs ? existing : null;
  if (!target) {
    const ext = path.extname(name).slice(1);
    const r = await dialog.showSaveDialog(win, { defaultPath: existing ? path.join(path.dirname(existing), name) : name, filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [] });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  fs.writeFileSync(target, Buffer.from(data));
  return target;
});

ipcMain.handle('save-many', async (_e, files) => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  for (const f of files) fs.writeFileSync(path.join(r.filePaths[0], f.name), Buffer.from(f.data));
  return r.filePaths[0];
});

// Installed fonts (for edited text): Windows' font folder and the per-user one.
const FONT_FILES = {
  arial: ['arial', 'arialbd', 'ariali', 'arialbi'], helvetica: ['arial', 'arialbd', 'ariali', 'arialbi'],
  'times new roman': ['times', 'timesbd', 'timesi', 'timesbi'], times: ['times', 'timesbd', 'timesi', 'timesbi'],
  calibri: ['calibri', 'calibrib', 'calibrii', 'calibriz'], 'segoe ui': ['segoeui', 'segoeuib', 'segoeuii', 'segoeuiz'],
  verdana: ['verdana', 'verdanab', 'verdanai', 'verdanaz'], georgia: ['georgia', 'georgiab', 'georgiai', 'georgiaz'],
  tahoma: ['tahoma', 'tahomabd', 'tahoma', 'tahomabd'], 'courier new': ['cour', 'courbd', 'couri', 'courbi'], courier: ['cour', 'courbd', 'couri', 'courbi'],
  'trebuchet ms': ['trebuc', 'trebucbd', 'trebucit', 'trebucbi'], aptos: ['aptos', 'aptos-bold', 'aptos-italic', 'aptos-bold-italic'],
};
const fontDirs = () => [path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Microsoft', 'Windows', 'Fonts')];
ipcMain.handle('system-font', async (_e, family, bold, italic) => {
  const key = String(family).toLowerCase().replace(/\s*(mt|ps|psmt)$/, '').trim();
  const style = (bold ? 1 : 0) + (italic ? 2 : 0);
  const names = FONT_FILES[key] ? [FONT_FILES[key][style]] : [key.replace(/\s+/g, '') + (bold ? 'bd' : ''), key.replace(/\s+/g, '')];
  for (const dir of fontDirs()) {
    for (const n of names) {
      for (const ext of ['.ttf', '.otf']) {
        const p = path.join(dir, n + ext);
        if (fs.existsSync(p)) { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
      }
    }
  }
  return null;
});

// Printing: the PDF opens in a viewer window with its own Print button.
ipcMain.handle('print', async (_e, data) => {
  const file = path.join(os.tmpdir(), `MK PDF print ${Date.now()}.pdf`);
  fs.writeFileSync(file, Buffer.from(data));
  const viewer = new BrowserWindow({ width: 900, height: 1000, title: 'Print', parent: win, autoHideMenuBar: true });
  viewer.loadURL(pathToFileURL(file).toString());
});

ipcMain.on('open-external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.on('set-dirty', (_e, value) => { dirty = !!value; });

// Updates: download the new installer to the temp folder, run it silently and quit. It installs per user over this
// copy (no admin, nothing to uninstall) and starts the new version when it's done (--force-run).
ipcMain.handle('install-update', async (_e, url, name) => {
  if (!/^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//.test(url)) throw new Error('Unexpected update location');
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const file = path.join(os.tmpdir(), path.basename(name || 'MK-PDF-setup.exe'));
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const child = spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' });
  child.unref();
  dirty = false;
  setTimeout(() => app.quit(), 500);
});
