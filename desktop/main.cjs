"use strict";
const { app, BrowserWindow, protocol, ipcMain, session, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { AudioClient } = require("./audio-client.cjs");
const { LocalLibrary } = require("./library.cjs");
const { inspectAudio, importSelection } = require("./importer.cjs");
const { APP_URL, validateIPC, authorize } = require("./policy.cjs");
protocol.registerSchemesAsPrivileged([{ scheme: "deckcraft", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

async function startDesktop({ userData, enginePath, chooseFile, show = true } = {}) {
  app.setName("Deck Craft");
  app.setAppUserModelId("org.deckcraft.desktop");
  app.setDesktopName("deck-craft.desktop");
  app.setPath("userData", userData || path.join(app.getPath("appData"), "deck-craft"));
  const data = app.getPath("userData");
  await fs.mkdir(data, { recursive: true, mode: 0o700 });
  const dataStat = await fs.lstat(data);
  if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) throw Error("Invalid application storage");
  await fs.chmod(data, 0o700);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }
  await app.whenReady();
  const root = path.resolve(__dirname, "..");
  const library = new LocalLibrary(app.getPath("userData"));
  await library.restore();
  const html = await fs.readFile(path.join(root, "dist/deck-craft.html"), "utf8");
  const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const hash = createHash("sha256").update(source).digest("base64");
  protocol.handle("deckcraft", (request) =>
    request.url === APP_URL && ["GET", "HEAD"].includes(request.method)
      ? new Response(request.method === "HEAD" ? "" : html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
          },
        })
      : new Response("Not found", { status: 404 }),
  );
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_w, _p, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) =>
    callback({ cancel: !details.url.startsWith("deckcraft://app/") && !details.url.startsWith("data:") }),
  );
  const window = new BrowserWindow({
    width: 1440,
    height: 1000,
    minWidth: 360,
    minHeight: 640,
    show: false,
    title: "Deck Craft",
    backgroundColor: "#101316",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== APP_URL) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  app.on("second-instance", () => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  const binary = enginePath || path.join(root, "native", "deck-craft-audio");
  let audio;
  let quitting = false;
  let reconnecting = false;
  let picking = false;
  let editingLibrary = false;
  const loadingTracks = new Map();
  // Renderer-selected tracks can outlive an unavailable/restarted audio child.
  // This is a bounded coordinator reference, not native transport authority.
  const retainedTracks = new Map();
  const notify = (message) => {
    if (!window.isDestroyed()) window.webContents.send("deckcraft:event", message);
  };
  function connect() {
    const client = new AudioClient(binary);
    audio = client;
    client.on("state", (snapshot) => {
      if (audio === client) notify({ type: "state", snapshot });
    });
    client.on("waveform", async (message) => {
      if (audio !== client) return;
      let track;
      try {
        const active = client.snapshot.decks.find((d) => d.id === message.deck && d.trackId === message.trackId);
        if (!active) return;
        library.commit(message.trackId, active);
        track = library.waveform(message.trackId, message.peaks);
      } catch {
        return;
      }
      if (track) {
        const saved = await library.save();
        if (audio === client) notify({ type: "track", track, warning: saved ? "" : library.warning });
      }
    });
  }
  connect();
  async function load(deck, trackId, client = audio) {
    if (client !== audio) throw Error("audio_source_changed");
    const r = library.get(trackId);
    loadingTracks.set(trackId, (loadingTracks.get(trackId) || 0) + 1);
    try {
      const snapshot = await client.request({ type: "load", deck, trackId: r.id, path: r.path, identity: r.identity });
      if (client !== audio) throw Error("audio_source_changed");
      const native = snapshot.decks.find((d) => d.id === deck);
      if (native?.trackId !== trackId) throw Error("load_cancelled");
      const track = library.commit(trackId, native);
      retainedTracks.set(deck, trackId);
      const saved = await library.save();
      return { track, snapshot, warning: saved ? "" : library.warning };
    } finally {
      const count = loadingTracks.get(trackId) - 1;
      if (count) loadingTracks.set(trackId, count); else loadingTracks.delete(trackId);
    }
  }
  ipcMain.handle("deckcraft:command", async (event, raw) => {
    if (!authorize(event, window)) return { ok: false, error: "unauthorized_frame" };
    try {
      const request = validateIPC(raw);
      let result;
      switch (request.type) {
        case "library":
          result = { tracks: library.list(), collections: library.collections, warning: library.warning };
          break;
        case "status":
          result = { snapshot: audio.snapshot };
          break;
        case "retain-track":
          if (editingLibrary) throw Error("library_busy");
          library.get(request.trackId);
          retainedTracks.set(request.deck, request.trackId);
          result = {};
          break;
        case "import": {
          if (picking || editingLibrary) throw Error("library_busy");
          picking = true;
          try {
            const options = {
              title: request.kind === "folder" ? "Add music folder to library" : "Add audio files to library",
              properties: request.kind === "folder" ? ["openDirectory"] : ["openFile", "multiSelections"],
              // GTK disables directory rows when an audio-file filter is used
              // with SELECT_FOLDER. Folder navigation must remain unfiltered.
              ...(request.kind === "folder" ? {} : { filters: [{ name: "Audio files", extensions: ["wav", "mp3", "flac", "ogg", "m4a", "aac", "aiff", "aif"] }] }),
            };
            const selected = chooseFile ? await chooseFile(window, options) : await dialog.showOpenDialog(window, options);
            if (selected.canceled || !selected.filePaths?.length) { result = { cancelled: true }; break; }
            result = await importSelection(library, selected.filePaths, {
              folder: request.kind === "folder", inspect: record => inspectAudio(binary, record),
              progress: progress => notify({ type: "import-progress", ...progress }),
            });
            // A renderer catalog replacement must include tracks outside this batch,
            // especially sources already loaded in the four native decks.
            result.tracks = library.list();
            result.collections = library.collections;
          } finally { picking = false; }
          break;
        }
        case "collection-create":
        case "collection-rename":
        case "collection-delete":
        case "collection-add":
        case "collection-remove":
        case "collection-move":
        case "forget": {
          if (picking || editingLibrary) throw Error("library_busy");
          editingLibrary = true;
          try {
            if (request.type === "forget") {
              if (request.trackIds.some(id => loadingTracks.has(id) || [...retainedTracks.values()].includes(id)) || audio.snapshot.decks.some(d => request.trackIds.includes(d.trackId))) throw Error("track_in_use");
              await library.forget(request.trackIds);
            } else result = { collection: await library.changeCollection(request) };
            result = { ...result, tracks: library.list(), collections: library.collections, warning: library.warning };
          } finally { editingLibrary = false; }
          break;
        }
        case "pick": {
          if (picking || editingLibrary) throw Error("library_busy");
          picking = true;
          try {
            const pickerClient = audio;
            const selected = chooseFile
              ? await chooseFile(window)
              : await dialog.showOpenDialog(window, {
                  title: "Load audio into deck " + request.deck,
                  properties: ["openFile"],
                  filters: [
                    { name: "Audio files", extensions: ["wav", "mp3", "flac", "ogg", "m4a", "aac", "aiff", "aif"] },
                    { name: "All files", extensions: ["*"] },
                  ],
                });
            if (selected.canceled || !selected.filePaths?.length) {
              result = { cancelled: true };
              break;
            }
            if (pickerClient !== audio) throw Error("audio_source_changed");
            const record = await library.select(selected.filePaths[0]);
            try {
              result = await load(request.deck, record.id, pickerClient);
            } catch (error) {
              if (!record.duration) library.records.delete(record.id);
              throw error;
            }
          } finally {
            picking = false;
          }
          break;
        }
        case "load":
          if (editingLibrary) throw Error("library_busy");
          result = await load(request.deck, request.trackId);
          break;
        case "reconnect":
          if (reconnecting) throw Error("audio_reconnecting");
          reconnecting = true;
          try {
            await audio.stop();
            connect();
            result = { snapshot: await audio.request({ type: "status" }) };
          } finally {
            reconnecting = false;
          }
          break;
        default:
          result = { snapshot: await audio.request(request) };
      }
      return { ok: true, ...result };
    } catch (error) {
      const code = /^[a-z][a-z_]{0,60}$/.test(error.message) ? error.message : "audio_command_failed";
      return { ok: false, error: code };
    }
  });
  await audio.request({ type: "status" }).catch(() => {});
  await window.loadURL(APP_URL);
  if (show) window.show();
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    audio
      .stop()
      .catch(() => {})
      .finally(() => app.quit());
  });
  window.webContents.on("render-process-gone", () => {
    audio.stop().catch(() => app.quit());
  });
  return { window, library, getAudio: () => audio, load };
}
if (require.main === module)
  startDesktop().catch(() => {
    console.error("Deck Craft could not start. Check your user-local installation and audio device.");
    app.quit();
    process.exitCode = 1;
  });
module.exports = { startDesktop };
