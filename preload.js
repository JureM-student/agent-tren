const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tren", {
  onState: (fn) => ipcRenderer.on("state", (_e, s) => fn(s)),
  onAttention: (fn) => ipcRenderer.on("attention", (_e, id) => fn(id)),
  decide: (payload) => ipcRenderer.send("decide", payload),
  dismiss: (id) => ipcRenderer.send("dismiss", id),
  openVSCode: (id) => ipcRenderer.send("open-vscode", id),
  resize: (h) => ipcRenderer.send("resize", h),
  onPrefs: (fn) => ipcRenderer.on("prefs", (_e, p) => fn(p)),
  connect: () => ipcRenderer.send("connect"),
  hide: () => ipcRenderer.send("hide"),
  setCollapsed: (v) => ipcRenderer.send("collapsed", v),
  setMuted: (v) => ipcRenderer.send("muted", v),
});
