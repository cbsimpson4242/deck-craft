"use strict";
// Real Electron + real native engine: the shared mixer's gain / EQ / filter knobs reach the engine,
// show real dB/frequency values, survive every layout and a complete application restart.
const assert = require("node:assert/strict");
const DECKS = ["A", "B", "C", "D"];
const FIELDS = ["gain", "hi", "mid", "low", "filter"];
const PAIRS = ["ab", "cd"];
// Distinct, non-neutral values for every deck and knob, including an unloaded deck.
const TARGET = {
  A: { gain: 62, hi: 20, mid: 80, low: 35, filter: 25 },
  B: { gain: 38, hi: 90, mid: 10, low: 65, filter: 75 },
  C: { gain: 55, hi: 5, mid: 45, low: 95, filter: 60 },
  D: { gain: 100, hi: 50, mid: 0, low: 10, filter: 0 },
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async function mixerDesktop({ js, command, until, checks, phase, expected }) {
  const native = async () => (await command({ type: "status" })).snapshot;
  const nativeStrip = async () => {
    const snapshot = await native();
    return Object.fromEntries(snapshot.decks.map((d) => [d.id, Object.fromEntries(FIELDS.map((f) => [f, d[f]]))]));
  };
  const knobs = (deck, field) => `document.querySelectorAll('input[data-action="deck-number"][data-deck="${deck}"][data-field="${field}"]')`;
  const dialogKnob = (deck, field) => `document.querySelector('.console-row .mixer input[data-deck="${deck}"][data-field="${field}"]')`;
  const setKnob = (deck, field, value) => js(`{const i=${dialogKnob(deck, field)};i.value=${value};i.dispatchEvent(new Event('input',{bubbles:true}));}`);
  const uiValues = (deck, field) => js(`[...${knobs(deck, field)}].map(i=>Number(i.value))`);
  if (phase === "restore") {
    assert.deepEqual(await until(async () => {
      const strip = await nativeStrip();
      return JSON.stringify(strip) === JSON.stringify(expected.strip) ? strip : false;
    }, "saved gain/EQ/filter restored to the new engine"), expected.strip);
    assert.deepEqual((await native()).decks.map(d=>d.assign),expected.assignments);
    assert.ok((await native()).decks.every(d=>d.meter.l===0&&d.meter.r===0));
    const saved = await js("JSON.parse(localStorage.getItem('deck-craft.ui.v1'))");
    for (const deck of DECKS) for (const field of FIELDS) {
      assert.equal(saved.decks[deck][field], expected.strip[deck][field], `saved ${deck} ${field}`);
      assert.ok((await uiValues(deck, field)).every((v) => v === expected.strip[deck][field]), `UI ${deck} ${field}`);
    }
    assert.equal(await js(`${dialogKnob("D", "filter")}.disabled`), false);
    assert.ok((await native()).decks.every((d) => !d.playing), "restore never starts playback");
    checks.push("Restart restores every deck's gain/EQ/filter into the new engine and UI, with playback still paused");
    return;
  }
  // ---- first phase ----
  assert.equal(await js("document.querySelectorAll('.console-row .mixer input[data-action=\"deck-number\"]').length"), 4 * 6, "four decks × (level + five strip knobs)");
  for (const deck of DECKS) for (const field of FIELDS) {
    assert.equal(await js(`${dialogKnob(deck, field)}.disabled`), false, `${deck} ${field} enabled with a ready engine`);
    assert.equal(await js(`${dialogKnob(deck, field)}.getAttribute('aria-valuetext')`), field === "filter" ? "Filter off" : "0 dB");
  }
  checks.push("Full mixer exposes GAIN, HI, MID, LOW and FILTER for all four decks, enabled and labelled");
  for (const deck of DECKS) for (const field of FIELDS) await setKnob(deck, field, TARGET[deck][field]);
  await until(async () => JSON.stringify(await nativeStrip()) === JSON.stringify(TARGET), "every knob reached the native engine");
  assert.equal(await js(`${dialogKnob("A", "filter")}.getAttribute('aria-valuetext')`), "Low-pass 1.41 kHz");
  assert.equal(await js(`${dialogKnob("B", "filter")}.getAttribute('aria-valuetext')`), "High-pass 490 Hz");
  await until(async()=>await js(`${dialogKnob("D", "mid")}.getAttribute('aria-valuetext')`)==="KILL","kill readout painted after native acknowledgement");
  assert.equal(await js(`${dialogKnob("D", "gain")}.getAttribute('aria-valuetext')`), "plus 12.0 dB");
  assert.equal(await js(`${dialogKnob("A", "gain")}.closest('label').querySelector('.knob-readout').textContent`), "+2.9 dB");
  checks.push("UI knob moves on all four decks (including unloaded C/D) reach the native engine; readouts are real dB / Hz");
  // Rapid drag: only the final value matters, and it must arrive.
  for (let v = 1; v <= 40; v++) await setKnob("A", "hi", v);
  await until(async () => (await nativeStrip()).A.hi === 40, "rate-limited drag ends on its final value");
  // Double-click returns to the neutral detent, in the engine as well as the UI.
  await js(`${dialogKnob("A", "hi")}.closest('label').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await until(async () => (await nativeStrip()).A.hi === 50, "double-click reset reached the engine");
  assert.equal(await js(`${dialogKnob("A", "hi")}.value`), "50");
  await until(async () => (await js(`${dialogKnob("A", "hi")}.getAttribute('aria-valuetext')`)) === "0 dB", "neutral reset rendered on the next animation frame");
  await setKnob("A", "hi", TARGET.A.hi);
  await until(async () => (await nativeStrip()).A.hi === TARGET.A.hi, "target restored after reset test");
  checks.push("Drag rate limiting ends on the final value; double-click resets a knob to exactly 50 in the engine");
  for(const deck of DECKS){
    await js(`document.querySelector('.console-row [data-action=eq-kill][data-deck=${deck}][data-band=hi]').click()`);
    await until(async()=>(await nativeStrip())[deck].hi===0,"label kill "+deck);
    await until(()=>js(`document.querySelector('.console-row [data-action=eq-kill][data-deck=${deck}][data-band=hi]').getAttribute('aria-pressed')==='true'`),"label kill state "+deck);
    await js(`document.querySelector('.console-row [data-action=eq-kill][data-deck=${deck}][data-band=hi]').click()`);
    await until(async()=>(await nativeStrip())[deck].hi===TARGET[deck].hi,"label restore "+deck);
    await js(`document.querySelector('.console-row [data-action=assign][data-deck=${deck}][data-value=right]').click()`);
    await until(async()=>(await native()).decks.find(d=>d.id===deck).assign==="right","right assignment "+deck);
  }
  checks.push("All four channels: native HI label kill/restoration and independent crossfader assignment");
  const before = await native();
  for (const from of PAIRS) for (const to of PAIRS) {
    await js(`document.querySelector('[data-action="pair"][data-value="${from}"]').click();document.querySelector('[data-action="pair"][data-value="${to}"]').click()`);
    assert.deepEqual(await nativeStrip(), TARGET, `${from} → ${to} keeps engine settings`);
    for (const deck of DECKS) for (const field of FIELDS)
      assert.ok((await uiValues(deck, field)).every((v) => v === TARGET[deck][field]), `${to}: UI ${deck} ${field}`);
  }
  await js(`document.querySelector('[data-action="pair"][data-value="ab"]').click()`);
  const after = await native();
  assert.equal(after.engineId, before.engineId);
  assert.deepEqual(after.decks.map((d) => [d.trackId, d.loadGeneration, d.playing]), before.decks.map((d) => [d.trackId, d.loadGeneration, d.playing]), "layout changes neither reload nor restart audio");
  checks.push("Console deck-pair transitions keep every knob value in UI and engine, with no reload or restart of audio");
  assert.equal(await js("document.querySelector('.console-row .mixer input[data-field=\"filter\"]').disabled"), false);
  return { strip: TARGET,assignments:["right","right","right","right"] };
};
