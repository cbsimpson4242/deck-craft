"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "deckCraftNative",
  Object.freeze({
    version: 1,
    command: (request) => ipcRenderer.invoke("deckcraft:command", request),
    onEvent: (callback) => {
      if (typeof callback !== "function") throw Error("invalid_callback");
      const listener = (_event, message) => callback(message);
      ipcRenderer.on("deckcraft:event", listener);
      return () => ipcRenderer.removeListener("deckcraft:event", listener);
    },
  }),
);
