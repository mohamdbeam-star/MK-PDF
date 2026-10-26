// Exposes the desktop bridge (window.mkpdf) to the web app; see src/app/platform.ts.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mkpdf', {
  version: ipcRenderer.sendSync('version'),
  openDialog: (accept, multiple) => ipcRenderer.invoke('open-dialog', accept, multiple),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  save: (name, data, p, saveAs) => ipcRenderer.invoke('save', name, data, p, saveAs),
  saveMany: (files) => ipcRenderer.invoke('save-many', files),
  systemFont: (family, bold, italic) => ipcRenderer.invoke('system-font', family, bold, italic),
  print: (data) => ipcRenderer.invoke('print', data),
  onOpenFile: (cb) => {
    ipcRenderer.on('open-file', (_e, f) => cb(f));
    // Files passed on the command line (or double-clicked) before the page was ready.
    ipcRenderer.invoke('pending-files').then((files) => files.forEach(cb));
  },
  openExternal: (url) => ipcRenderer.send('open-external', url),
  installUpdate: (url, name) => ipcRenderer.invoke('install-update', url, name),
  setDirty: (v) => ipcRenderer.send('set-dirty', v),
});
