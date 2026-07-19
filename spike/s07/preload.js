const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('spike', {
  onData: (cb) => ipcRenderer.on('pty:data', (_e, d) => cb(d)),
  input: (d) => ipcRenderer.send('pty:input', d),
  jank: (j) => ipcRenderer.send('jank', j),
});
