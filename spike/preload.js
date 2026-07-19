const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pty', {
  ready: (cols, rows) => ipcRenderer.send('pty:ready', { cols, rows }),
  input: (data) => ipcRenderer.send('pty:input', data),
  resize: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),
  onData: (cb) => ipcRenderer.on('pty:data', (_e, data) => cb(data)),
});
