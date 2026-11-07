"use strict";
// Real Electron pointer input through the sandboxed renderer/bridge into the real native engine.
// The parent desktop suite supplies generated audio, a private display and an explicit isolated sink.
const assert = require("node:assert/strict");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async ({ js, command, until, checks, window }) => {
  const status = async () => (await command({ type: "status" })).snapshot;
  window.focus();
  const initial = await status();
  const middle = initial.decks[0].duration / 3;
  await command({ type: "seek", deck: "A", position: middle });
  const expectedClock = String(Math.floor(middle / 60)).padStart(2, "0") + ":" + String(Math.floor(middle) % 60).padStart(2, "0") + ".0";
  await until(() => js(`document.querySelector('section.deck[data-deck="A"] .elapsed').textContent===${JSON.stringify(expectedClock)}`), "renderer consumed the paused setup receipt");
  // Start away from the endpoint, with renderer and native positions agreed.
  const before = await status();
  assert.equal(before.decks[0].playing, false);
  const rect = () => js(`(async () => {
    const e=document.querySelector('[data-wave-deck="A"].detail');
    e.scrollIntoView({block:'center'});
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width*.55);
    const safeY=[.85,.9,.65,.4].map(f=>Math.round(r.y+r.height*f)).find(y=>{
      const hit=document.elementFromPoint(x,y);
      return hit?.closest('.wavebox.detail')===e&&!hit.closest('.zoom-ctl');
    });
    if(safeY===undefined)throw Error('No unobstructed waveform drag point');
    return {x:r.x,y:r.y,width:r.width,height:r.height,safeY};
  })()`);
  const point = (type, x, y, pressed = false) => window.webContents.sendInputEvent({
    type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: type === "mouseMove" ? 0 : 1,
    modifiers: pressed ? ["leftButtonDown"] : [],
  });
  // Observe delivery after the application's pointer handlers. sendInputEvent queues renderer work;
  // neither the initial hover nor a status RPC substitutes for an acknowledged pointer-down/up.
  await js(`window.__scrubInput={down:0,up:0};for(const name of ['pointerdown','pointerup'])document.getElementById('app').addEventListener(name,event=>{if(event.target.closest?.('.wavebox.detail')){window.__scrubInput[name==='pointerdown'?'down':'up']++;window.__scrubInput.target=event.target.className;window.__scrubInput.primary=event.isPrimary;window.__scrubInput.pointerId=event.pointerId;}});`);
  async function drag(dx, { hold = false } = {}) {
    const r = await rect();
    const x = Math.round(r.x + r.width * .55), y = r.safeY;
    await js("window.__scrubInput={down:0,up:0}");
    point("mouseMove", x, y);
    point("mouseDown", x, y);
    await until(() => js("window.__scrubInput.down===1"), "real pointer-down delivered");
    for (let i = 1; i <= 12; i++) { point("mouseMove", x + dx * i / 12, y, true); await delay(12); }
    try {
      await until(() => js("document.querySelector('[data-wave-deck=A].detail').classList.contains('scrubbing')"), "real drag engaged");
    } catch(error) {
      throw Error(error.message+" "+JSON.stringify(await js("({input:window.__scrubInput,toast:document.querySelector('.toast')?.textContent,focus:document.activeElement?.className,hit:document.elementFromPoint("+x+","+y+")?.className})")));
    }
    const release = async () => {
      point("mouseUp", x + dx, y);
      await until(() => js("window.__scrubInput.up===1"), "real pointer-up delivered");
    };
    if (!hold) await release();
    return { r, x, y, release };
  }
  await js(`document.querySelector('[data-wave-deck="A"].detail [data-action="zoom-in"]').click()`);
  const coarseZoom=await js(`Number(document.querySelector('[data-wave-deck="A"].detail').dataset.waveZoom)`);
  const duration = before.decks[0].duration;
  let base = before.decks[0].position;
  const coarse = await drag(-50, { hold: true });
  assert.ok(Math.abs((await status()).decks[0].position - base) < .02, "paused drag previews without decoder movement");
  await coarse.release();
  const coarseDelta = 50 * duration / coarseZoom / coarse.r.width;
  await until(async () => { const d = (await status()).decks[0]; return !d.loading && Math.abs(d.position - Math.min(duration, base + coarseDelta)) < .025; }, "real pointer-up precise paused seek");
  assert.equal((await status()).decks[0].playing, false);
  await js(`for(let i=0;i<3;i++)document.querySelector('[data-wave-deck="A"].detail [data-action="zoom-in"]').click()`);
  base = (await status()).decks[0].position;
  const fine = await drag(-50);
  const fineZoom=await js(`Number(document.querySelector('[data-wave-deck="A"].detail').dataset.waveZoom)`);
  const fineDelta = 50 * duration / fineZoom / fine.r.width;
  await until(async () => { const d = (await status()).decks[0]; return !d.loading && Math.abs(d.position - Math.min(duration, base + fineDelta)) < .025; }, "zoom-scaled fine native seek");
  assert.ok(fineDelta < coarseDelta, "zoom in gives finer native control");
  await js(`document.querySelector('section.deck[data-deck="A"] .play').click()`);
  await until(async () => (await status()).decks[0].playing, "play before real scrub");
  await drag(-70);
  await until(async () => { const d = (await status()).decks[0]; return d.playing && !d.loading; }, "playing scrub stays playing");
  const after = await status();
  assert.equal(after.engineId, before.engineId);
  assert.equal(after.decks[0].trackId, before.decks[0].trackId);
  for (let i = 1; i < 4; i++) {
    assert.equal(after.decks[i].trackId, before.decks[i].trackId);
    assert.equal(after.decks[i].playing, before.decks[i].playing);
  }
  await js(`document.querySelector('section.deck[data-deck="A"] .play').click()`);
  await until(async () => !(await status()).decks[0].playing, "pause after real scrub");
  checks.push("Real Electron mouse drag → native seek: paused preview, final positions within 25 ms, finer zoom sensitivity, playing-state and other-deck preservation");
};
