import { contextBridge, ipcRenderer } from "electron/renderer";

contextBridge.exposeInMainWorld("veluneImagePreview", {
  save: () => ipcRenderer.invoke("velune:imagePreviewSave"),
  close: () => ipcRenderer.invoke("velune:imagePreviewClose"),
});
