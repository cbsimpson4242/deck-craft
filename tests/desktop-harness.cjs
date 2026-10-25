"use strict";
// Test-only entry point. The shipped desktop entry contains no test API.
const { startDesktop } = require("../desktop/main.cjs");
const { app } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw Error("Timed out: " + label);
}
async function run() {
  const dir = process.env.DECKCRAFT_TEST_DIR;
  if (!dir) throw Error("DECKCRAFT_TEST_DIR required");
  await fs.mkdir(dir, { recursive: true });
  const phase = process.env.DECKCRAFT_TEST_PHASE || "first";
  const realDialog = process.env.DECKCRAFT_TEST_NATIVE_DIALOG === "1";
  const filename = path.join(dir, "Generated local <audio> fixture.wav");
  if (phase === "first") {
    const rate = 48000,
      frames = rate * 30,
      b = Buffer.alloc(44 + frames * 4);
    b.write("RIFF");
    b.writeUInt32LE(b.length - 8, 4);
    b.write("WAVEfmt ", 8);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(2, 22);
    b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate * 4, 28);
    b.writeUInt16LE(4, 32);
    b.writeUInt16LE(16, 34);
    b.write("data", 36);
    b.writeUInt32LE(frames * 4, 40);
    for (let i = 0; i < frames; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 6000);
      b.writeInt16LE(v, 44 + i * 4);
      b.writeInt16LE(v, 46 + i * 4);
    }
    await fs.writeFile(filename, b);
  }
  const errors = [];
  app.on("web-contents-created", (_event, contents) =>
    contents.on("console-message", (event) => {
      if (event.level === "error") {
        errors.push(event.message);
        console.error("Renderer error", event.message);
      }
    }),
  );
  const desktop = await startDesktop({
    userData: path.join(dir, "user-data"),
    enginePath: process.env.DECKCRAFT_TEST_ENGINE || path.resolve(__dirname, "../native/target/debug/deck-craft-audio"),
    chooseFile: async (owner) => {
      if (!realDialog) return { canceled: false, filePaths: [filename] };
      const result = await require("electron").dialog.showOpenDialog(owner, {
        title: "Load audio into deck A",
        properties: ["openFile"],
        filters: [{ name: "Audio files", extensions: ["wav"] }],
      });
      console.log("Native chooser receipt", JSON.stringify(result));
      return result;
    },
  });
  const { window } = desktop;
  window.webContents.on("render-process-gone", (_e, details) => errors.push("renderer gone: " + details.reason));
  const js = (code) =>
    window.webContents.executeJavaScript(code, true).catch((error) => {
      console.error("Failed renderer script", code);
      throw error;
    });
  const command = (object) => js(`window.deckCraftNative.command(${JSON.stringify(object)})`);
  const session = () => js("JSON.parse(localStorage.getItem('deck-craft.ui.v1'))");
  const ready = () => js("!!document.querySelector('.native-import')&&!document.querySelector('.native-import').disabled");
  await until(ready, "native bridge + native audio ready");
  const checks = [];
  const prefs = window.webContents.getLastWebPreferences();
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(await js("typeof require"), "undefined");
  assert.equal(await js("typeof process"), "undefined");
  checks.push("Sandboxed renderer with no Node or process access");
  assert.equal((await command({ type: "status", path: "/etc/passwd" })).ok, false);
  assert.equal((await command({ type: "shell", value: "arbitrary" })).ok, false);
  checks.push("Extra fields and arbitrary commands rejected at privileged IPC boundary");
  if (phase === "first") {
    await js("document.querySelector('[data-action=import-audio]').click()");
    if (realDialog) {
      await delay(500);
      console.log(
        "Dialog diagnostic",
        await js("document.querySelector('.native-audio-bar').textContent+' | '+document.querySelector('.toast').textContent"),
      );
      try {
        const ids = (await exec("xdotool", ["search", "--name", ".*"])).stdout.trim().split("\n");
        for (const id of ids.slice(0, 20)) console.log("X window", id, (await exec("xdotool", ["getwindowname", id])).stdout.trim());
      } catch {}
      const id = await until(async () => {
        try {
          return (await exec("xdotool", ["search", "--onlyvisible", "--name", "Load audio into deck A"])).stdout.trim().split("\n")[0];
        } catch {
          return false;
        }
      }, "real native file chooser");
      await exec("xdotool", ["windowfocus", "--sync", id]);
      await exec("xdotool", ["key", "--clearmodifiers", "ctrl+l"]);
      await exec("xdotool", ["type", "--clearmodifiers", "--delay", "1", filename]);
      await delay(500);
      const geometry = Object.fromEntries(
        (await exec("xdotool", ["getwindowgeometry", "--shell", id])).stdout
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      await exec("xdotool", [
        "mousemove",
        "--window",
        id,
        String(Number(geometry.WIDTH) - 50),
        String(Number(geometry.HEIGHT) - 25),
        "click",
        "1",
      ]);
      await delay(500);
      console.log(
        "Load diagnostic",
        await js("document.querySelector('.native-audio-bar').textContent+' | '+document.querySelector('.toast').textContent"),
        await command({ type: "library" }),
      );
    }
    await until(async () => {
      const s = await session();
      return s?.decks.A.trackId?.startsWith("local-");
    }, "actual chooser selection decoded and loaded");
    let s = await session();
    const idA = s.decks.A.trackId;
    let result = await command({ type: "library" });
    assert.ok(result.tracks.find((t) => t.id === idA));
    assert.ok(!JSON.stringify(result).includes(filename));
    assert.ok(!JSON.stringify(result).includes('"path"'));
    assert.equal((await fs.stat(path.join(dir, "user-data/library.json"))).mode & 0o777, 0o600);
    checks.push(
      (realDialog ? "Real GTK chooser" : "Injected fixture selection") +
        " loads real PCM; private paths stay out of renderer IPC and library is mode 0600",
    );
    await until(
      () => js("document.querySelector('section.deck[data-deck=A] .waveform')?.getAttribute('aria-label')?.startsWith('PCM amplitude')"),
      "decoded real waveform",
    );
    await js("document.querySelector('section.deck[data-deck=A] [data-field=playing]').click()");
    await until(async () => (await command({ type: "status" })).snapshot.decks[0].playing, "actual native play from UI");
    const start = (await command({ type: "status" })).snapshot;
    const layouts = ["signal-one", "signal-wide", "studio-grid", "studio-linear", "studio-sync"];
    let transitions = 0;
    for (const from of layouts)
      for (const to of layouts) {
        await js(
          `{const p=document.querySelector('.layout-picker');p.value=${JSON.stringify(from)};p.dispatchEvent(new Event('change',{bubbles:true}));p.value=${JSON.stringify(to)};document.querySelector('.layout-picker').value=${JSON.stringify(to)};document.querySelector('.layout-picker').dispatchEvent(new Event('change',{bubbles:true}));}`,
        );
        const native = (await command({ type: "status" })).snapshot;
        assert.equal(native.engineId, start.engineId);
        assert.equal(native.decks[0].trackId, idA);
        assert.equal(native.decks[0].loadGeneration, start.decks[0].loadGeneration);
        assert.equal(native.decks[0].playing, true);
        assert.equal(await js('document.querySelectorAll("iframe").length'), 0);
        transitions++;
      }
    checks.push(transitions + " layout transitions preserve the same playing native source without reload");
    await js("document.querySelector('section.deck[data-deck=A] [data-field=playing]').click()");
    await until(async () => !(await command({ type: "status" })).snapshot.decks[0].playing, "UI pause");
    await js(
      "{const x=document.querySelector('[data-wave-deck=A] .wave-seek');x.value=12.3;x.dispatchEvent(new Event('input',{bubbles:true}));}",
    );
    await until(
      async () => Math.abs((await command({ type: "status" })).snapshot.decks[0].position - 12.3) < 0.02,
      "UI seek confirmed by native engine",
    );
    await js(
      "document.querySelector('[data-action=hot-cue][data-deck=A][data-index=\"1\"]').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}))",
    );
    checks.push("UI pause, seek and manual cue storage follow native position");
    await js(
      `{const t=document.querySelector('.load-target');t.value='B';t.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('tr[data-track-id="${idA}"] .load').click();}`,
    );
    await until(async () => (await session()).decks.B.trackId === idA, "second deck loads selected local source");
    await js(
      "{const p=document.querySelector('.layout-picker');p.value='studio-linear';p.dispatchEvent(new Event('change',{bubbles:true}));}",
    );
    await delay(250);
    s = await session();
    assert.equal(s.layout, "studio-linear");
    assert.ok(Math.abs(s.decks.A.cues[1] - 12.3) < 0.02);
    assert.ok(!s.decks.A.playing && !s.decks.B.playing);
    checks.push("Second deck loads independently and final musical state is saved paused");
    await fs.writeFile(
      path.join(dir, "expected.json"),
      JSON.stringify({ trackId: idA, position: s.decks.A.position, cues: s.decks.A.cues, engineId: start.engineId }),
    );
    const image = await window.webContents.capturePage();
    await fs.writeFile(path.join(dir, "desktop.png"), image.toPNG());
  } else {
    const expected = JSON.parse(await fs.readFile(path.join(dir, "expected.json"), "utf8"));
    await until(async () => {
      const r = (await command({ type: "status" })).snapshot;
      return r.decks[0].trackId === expected.trackId && Math.abs(r.decks[0].position - expected.position) < 0.02;
    }, "restored real native source and position");
    const s = await session(),
      native = (await command({ type: "status" })).snapshot;
    assert.equal(s.layout, "studio-linear");
    assert.deepEqual(s.decks.A.cues, expected.cues);
    assert.notEqual(native.engineId, expected.engineId);
    assert.ok(native.decks.every((d) => !d.playing));
    assert.equal(s.decks.B.trackId, expected.trackId);
    checks.push("Complete app restart restores layout, local tracks, positions and cues, but never starts playback");
  }
  const bounds = await js(
    '({width:innerWidth,scroll:document.documentElement.scrollWidth,choices:document.querySelector(".layout-picker").options.length,errors:[]})',
  );
  assert.ok(bounds.scroll <= bounds.width);
  assert.equal(bounds.choices, 5);
  assert.deepEqual(errors, []);
  checks.push("Five choices, no horizontal overflow, no renderer errors");
  await fs.writeFile(
    path.join(dir, "desktop-" + phase + ".json"),
    JSON.stringify({ phase, checks, bounds, physicalDeviceTested: false }, null, 2),
  );
  console.log(JSON.stringify({ phase, checks, bounds, physicalDeviceTested: false }, null, 2));
  app.quit();
}
run().catch((error) => {
  console.error(error.stack);
  app.exit(1);
});
