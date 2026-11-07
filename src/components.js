import { TRACKS, THEMES, DECK_IDS, trackById, allTracks, backendActive } from './catalog.js';
import { nativeLibrary } from './library.js';
import { waveViewport } from './wave-zoom.js';
import { waveSource, paintWaveCanvas } from './wave-render.js';
import { knobReadout, knobTitle, knobValueText } from './mixer.js';

export const escapeHTML = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const timeLabel = (seconds,decimal=false) => {
  const n=Math.max(0,Math.round(seconds*10));
  return String(Math.floor(n/600)).padStart(2,'0')+':'+String(Math.floor(n/10)%60).padStart(2,'0')+(decimal?'.'+n%10:'');
};
const ICONS={play:'<path d="m9 5 10 7-10 7z" fill="currentColor" stroke="none"/>',pause:'<path d="M8 5v14M16 5v14" stroke-width="4"/>',headphones:'<path d="M4 15v-3a8 8 0 0 1 16 0v3M4 13h4v7H4zM16 13h4v7h-4z"/>',wave:'<path d="M3 10v4M7 6v12M11 3v18M15 7v10M19 5v14M23 10v4"/>',settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',cog:'<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8"/>',grid:'<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',folder:'<path d="M3 7V5h6l3 3h9v12H3z"/>',music:'<path d="M9 17V5l11-2v12M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',bookmark:'<path d="M6 3h12v18l-6-4-6 4z"/>',bolt:'<path d="m14 2-9 12h6l-1 8 9-12h-6z"/>',clock:'<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1"/>',arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',loop:'<path d="M9 7H6a5 5 0 0 0 0 10h6l6-10h-6L6 17m9 0h3a5 5 0 0 0 0-10h-6"/>',expand:'<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',skipStart:'<path d="M5 4v16m13-15L8 12l10 7Z"/>',skipEnd:'<path d="M19 4v16M6 5l10 7-10 7Z"/>',left:'<path d="m14 6-6 6 6 6"/>',right:'<path d="m10 6 6 6-6 6"/>',down:'<path d="m6 9 6 6 6-6"/>',store:'<path d="M5 18h14M12 15V4m-5 5 5-5 5 5"/>',trash:'<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>'};
export const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]||ICONS.grid}</svg>`;
let assetSequence=0;
export function resetAssetSequence(){assetSequence=0;}
/** Generated cover tile. Local files get the same neutral treatment as demo fixtures; nothing here is real artwork. */
export function sleeve(track,cls='') {
  if(track.local&&track.artwork)return `<img class="art ${cls}" src="${track.artwork}" alt="Album artwork for ${escapeHTML(track.title)}" width="64" height="64">`;
  return `<span class="art ${cls}" role="img" aria-label="${track.local?'Generated placeholder artwork for':'Synthetic sleeve for'} ${escapeHTML(track.title)}" style="--art:${track.color}"></span>`;
}
// Deck identity belongs to the deck. The hues come from the active theme so they stay legible on every surface.
export const deckColor = id => ({A:'var(--a)',B:'var(--b)',C:'var(--c)',D:'var(--d)'}[id]);
// ---- Waveform rendering ------------------------------------------------------------------
// Sampling and canvas painting live in wave-render.js. Local files draw decoded PCM data colored
// only by amplitude; demo tracks use a deterministic synthetic fixture. Neither is frequency
// analysis or a beat grid.
const WAVE_HEIGHT=90;
export function paintWaveBox(box,ratio,track,{elements=null}={}) {
  const r=Math.max(0,Math.min(1,Number.isFinite(ratio)?ratio:0));
  const scroll=box.classList?.contains('scroll'),overview=box.classList?.contains('overview');
  const viewport=waveViewport(r,overview?1:Number(box.dataset?.waveZoom)||(scroll?5:1),scroll);
  const seek=elements?elements.seek:box.querySelector('.wave-seek'),duration=Number(box.dataset?.waveDuration);
  const seeking=seek&&typeof document!=='undefined'&&document.activeElement===seek;
  // Keep pointer/keyboard seek coordinates stable for the duration of the focused gesture.
  if(seeking&&duration>0&&!scroll&&!overview) {
    viewport.start=Number(seek.min)/duration;viewport.end=Number(seek.max)/duration;
    viewport.marker=(r-viewport.start)*viewport.zoom;
  }
  box.style.setProperty('--pos',String(r));
  box.style.setProperty('--wave-start',String(viewport.start));
  const marker=elements?elements.marker:box.querySelector('.position-marker');if(marker)marker.style.left=viewport.marker*100+'%';
  if(seek&&duration>0&&!seeking) {
    seek.min=String(Math.max(0,viewport.start)*duration);
    seek.max=String(Math.min(1,viewport.end)*duration);
    seek.value=String(r*duration);
  }
  const shade=elements?elements.shade:box.querySelector('.played-shade');if(shade)shade.style.width=r*100+'%';
  (elements?elements.section:box.closest?.('section.deck'))?.style.setProperty('--pos',String(r));
  // The canvas draws the displayed interval itself, so it repaints with the viewport.
  const canvas=track?(elements?elements.canvas:box.querySelector('canvas.wave-canvas')):null;
  if(canvas)paintWaveCanvas(canvas,track,viewport,{scroll,metrics:elements?.metrics});
}
// Static creator previews have no deck state: repaint their synthetic fixture waveforms in place.
export function paintFixtureWaves(container) {
  for(const canvas of container.querySelectorAll('canvas.wave-canvas.wave-fixture')){
    const box=canvas.closest('.wavebox'),index=Number(canvas.className.match(/wave-fixture-(\d+)/)?.[1]);
    if(!box||!(index>=0&&index<TRACKS.length))continue;
    const scroll=box.classList.contains('scroll'),overview=box.classList.contains('overview');
    paintWaveCanvas(canvas,TRACKS[index],waveViewport(Number(box.style.getPropertyValue('--pos'))||0,overview?1:Number(box.style.getPropertyValue('--zoom'))||(scroll?5:1),scroll),{scroll});
  }
}
const cueIsSet=(cue,index)=>index===0||cue>0;
export function wave(id,state,{mini=false,color=deckColor(id),scroll=false,overview=false}={}) {
  const deck=state.decks[id],track=trackById(deck.trackId),source=waveSource(track);
  const columns=scroll?2048:overview?640:900,ratio=deck.position/track.duration;
  const label=track.local?(source?(track.beatGrid?'PCM amplitude waveform with detected beat grid':'PCM amplitude waveform — not a beat grid'):'PCM waveform analysis pending'):'Synthetic waveform fixture — not analyzed audio';
  const flags=mini?'':deck.cues.map((cue,i)=>`<span class="cue-flag cue-${i+1}" data-cue-flag="${i}" style="left:${cue/track.duration*100}%" ${cueIsSet(cue,i)?'':'hidden'}><b>${i+1}</b></span>`).join('');
  // Drawn data lives on a canvas painted for the displayed interval (paintWaveBox); a local file with
  // no peaks yet shows only the center line.
  const fixtureClass=track.local?'':` wave-fixture wave-fixture-${Math.max(0,TRACKS.indexOf(track))}`;
  const drawing=source?`<canvas class="waveform wave-canvas${fixtureClass}" data-wave-layer="column" role="img" aria-label="${label}" style="--wave-line:${escapeHTML(color)}"></canvas>`:`<svg class="waveform" viewBox="0 0 ${columns} ${WAVE_HEIGHT}" preserveAspectRatio="none" role="img" aria-label="${label}"><path class="wl-axis" d="M0 ${WAVE_HEIGHT/2}H${columns}" vector-effect="non-scaling-stroke"/></svg>`;
  const classes=`wavebox ${mini?'mini':''} ${scroll?'scroll':''} ${overview?'overview':'detail'}`;
  const seek=scroll?'':`<input class="wave-seek" type="range" data-action="deck-number" data-deck="${id}" data-field="position" min="0" max="${track.duration}" step="0.1" value="${deck.position}" aria-label="Seek deck ${id}" title="Seek UI position; no audio engine">`;
  const controls=overview?'':`<div class="zoom-ctl" role="group" aria-label="Deck ${id} waveform zoom"><button type="button" data-action="zoom-in" data-deck="${id}" aria-label="Zoom in deck ${id} waveform">+</button><output class="zoom-label" aria-label="Visible time"></output><button type="button" data-action="zoom-out" data-deck="${id}" aria-label="Zoom out deck ${id} waveform">−</button></div>`;
  const slider=overview?'':` tabindex="0" role="slider" aria-label="Deck ${id} waveform position. Drag to scrub; arrows seek; plus and minus zoom." aria-valuemin="0" aria-valuemax="${track.duration}" aria-valuenow="${deck.position}"`;
  return `<div class="${classes}"${slider} data-wave-deck="${id}" data-wave-duration="${track.duration}" data-wave-color="${track.local?'amplitude':'fixture'}" style="--pos:${ratio};--zoom:${scroll?5:1}">${drawing}<div class="wave-track">${flags}</div>${overview?`<span class="played-shade" style="width:${ratio*100}%"></span>`:''}<span class="position-marker" style="left:${ratio*100}%"></span>${seek}${controls}</div>`;
}
export function knob(label,field,id,state) {
  const value=state.decks[id][field];
  return `<label class="knob" title="${knobTitle(id,field,value)}"><span class="dial" style="--v:${value}"><i style="transform:rotate(${(value-50)*2.7}deg)"></i></span><input type="range" data-action="deck-number" data-deck="${id}" data-field="${field}" min="0" max="100" step="1" value="${value}" aria-label="Deck ${id} ${escapeHTML(label)}" aria-valuetext="${knobValueText(field,value)}"><output class="knob-readout" aria-hidden="true">${knobReadout(field,value)}</output><small>${escapeHTML(label)}</small></label>`;
}
export function eqKnob(label,field,id,state) {
  const killed=state.decks[id][field]===0;
  return `<div class="eq-band">${knob(label,field,id,state).replace('<small>'+label+'</small>','')}<button type="button" class="band-kill" data-action="eq-kill" data-deck="${id}" data-band="${field}" aria-pressed="${killed}" aria-label="Kill ${label} on channel ${id}" title="Kill this band; press again to restore its previous setting">${label}</button></div>`;
}
export function assignGroup(id,state) {
  return `<div class="xf-assign" role="group" aria-label="Channel ${id} crossfader assignment">${[['left','L'],['thru','THRU'],['right','R']].map(([value,text])=>`<button type="button" data-action="assign" data-deck="${id}" data-value="${value}" aria-pressed="${state.decks[id].assign===value}" aria-label="Channel ${id} crossfader ${value}">${text}</button>`).join('')}</div>`;
}
/** Repaint one existing knob from the shared model: dial angle, real dB/frequency readout, spoken value. */
export function paintKnob(label,deck,field,value) {
  label.querySelector('.dial')?.style.setProperty('--v',value);
  const dial=label.querySelector('.dial i');if(dial)dial.style.transform=`rotate(${(value-50)*2.7}deg)`;
  const input=label.querySelector('input'),readout=label.querySelector('.knob-readout');
  input?.setAttribute('aria-valuetext',knobValueText(field,value));
  if(readout)readout.textContent=knobReadout(field,value);
  label.title=knobTitle(deck,field,value);
}
const loopPresets=[4,8,16];
const pitchText=value=>(value>=0?'+':'')+value.toFixed(1)+'%';
export function transport(id,state) {
  const d=state.decks[id];
  return `<div class="transport"><button class="play" data-action="toggle-deck" data-deck="${id}" data-field="playing" aria-label="${d.playing?'Pause':'Play'} deck ${id} UI transport; no audio" aria-pressed="${d.playing}">${icon(d.playing?'pause':'play')}<span>${d.playing?'PAUSE':'PLAY'}</span></button><button class="cue" data-action="cue" data-deck="${id}" aria-label="Return deck ${id} to cue">CUE</button><button class="sync" data-action="toggle-deck" data-deck="${id}" data-field="sync" aria-pressed="${d.sync}">SYNC</button><div class="loop-group" role="group" aria-label="Deck ${id} loop"><button class="tiny less" data-action="loop-size" data-deck="${id}" data-factor="0.5" aria-label="Halve deck ${id} loop length">${icon('left')}</button><button class="loop" data-action="toggle-deck" data-deck="${id}" data-field="loopEnabled" aria-pressed="${d.loopEnabled}" aria-label="Loop UI state, length ${d.loopLength}">${icon('loop')}<span class="loop-label">LOOP</span><span class="loop-len">${d.loopLength}</span></button><button class="tiny more" data-action="loop-size" data-deck="${id}" data-factor="2" aria-label="Double deck ${id} loop length">${icon('right')}</button></div></div>`;
}
export function pads(id,state) {
  const d=state.decks[id];
  return `<div class="pads" data-pad-panel="cue" data-pad-deck="${id}">${d.cues.map((cue,i)=>`<button class="pad p${i} ${cueIsSet(cue,i)?'filled':''}" data-action="hot-cue" data-deck="${id}" data-index="${i}" aria-label="Deck ${id} hot cue ${i+1}; Shift-click to store position" title="Jump to cue ${i+1}. Shift-click or right-click to store current position." aria-pressed="${Math.abs(cue-d.position)<.05}"><strong>${i+1}</strong><span class="pad-name">${['INTRO','IN','DROP','BREAK'][i]}</span><small>${timeLabel(cue)}</small></button>`).join('')}${[5,6,7,8].map(n=>`<span class="pad-slot" aria-hidden="true" title="Slot ${n} is reserved; this build stores four manual cues.">${n}</span>`).join('')}</div>`;
}
const LOOP_PADS=[1,2,4,8,16,32];
export function loopPads(id,state,hidden=true) {
  const d=state.decks[id];
  return `<div class="loop-pads" data-pad-panel="loop" data-pad-deck="${id}" ${hidden?'hidden':''}>${LOOP_PADS.map(n=>`<button class="pad loop-pad" data-action="loop-length" data-deck="${id}" data-value="${n}" aria-pressed="${d.loopLength===n}" aria-label="Set deck ${id} loop length to ${n}"><strong>${n}</strong><span class="pad-name">${n===1?'BEAT':'BEATS'}</span></button>`).join('')}<button class="pad pad-off" disabled title="Loop in is not implemented"><strong>IN</strong></button><button class="pad pad-off" disabled title="Loop out is not implemented"><strong>OUT</strong></button></div>`;
}
export function pitch(id,state) {
  const value=state.decks[id].pitch;
  return `<label class="pitch"><span class="pitch-label">TEMPO</span><input type="range" data-action="deck-number" data-deck="${id}" data-field="pitch" min="-8" max="8" step="0.1" value="${value}" aria-label="Deck ${id} tempo"><output>${pitchText(value)}</output></label>`;
}
// Measured BPM (native or browser analysis) follows the tempo fader; demo fixtures keep their fixture value.
export const bpmText=(track,pitchPercent=0)=>track.local?(track.bpm?(track.bpm*(1+pitchPercent/100)).toFixed(2):'—'):track.bpm.toFixed(1);
export const bpmNote=track=>track.local?(track.bpm?'BPM · DETECTED':track.analysisVersion?'BPM UNAVAILABLE':'ANALYSIS PENDING'):'BPM';
const keyHue=key=>{const n=parseInt(key,10);return Number.isFinite(n)?(n-1)*30:null;};
const keyBadge=(key,cls='')=>{const hue=keyHue(key);return `<span class="${['key',cls,hue===null?'key-none':''].filter(Boolean).join(' ')}" ${hue===null?'':`style="--k:${hue}"`}>${escapeHTML(key)}</span>`;};
export function lane(id,state) {
  const d=state.decks[id],t=trackById(d.trackId);
  return `<section class="deck deck-lane" data-deck="${id}" data-drop-deck="${id}" style="--deck:${deckColor(id)}" aria-label="Deck ${id} waveform"><div class="lane-info"><b class="deck-letter">${id}</b><div class="lane-title"><strong class="track-title">${escapeHTML(t.title)}</strong><span class="track-artist">${escapeHTML(t.artist)}</span></div><div class="lane-tempo"><strong class="bpm-value">${bpmText(t,d.pitch)}</strong><small>${bpmNote(t)} · <span class="remaining">−${timeLabel(t.duration-d.position)}</span></small></div></div><div class="lane-wave">${wave(id,state,{scroll:true})}${wave(id,state,{overview:true})}</div></section>`;
}
/** Real tempo-master, pitch-lock and library-load controls. SYNC stays in the transport row. */
export function deckTools(id,state){
  const d=state.decks[id];
  return `<div class="dk-strip deck-tools"><button class="dk-chip master" data-action="master" data-deck="${id}" aria-pressed="${state.master===id}" title="Make this deck the tempo master that SYNC follows">MASTER</button><button class="dk-chip pitch-lock" data-action="toggle-deck" data-deck="${id}" data-field="pitchLock" aria-pressed="${d.pitchLock}" title="Keep pitch unchanged when tempo changes">PITCH LOCK</button><button class="dk-chip" data-action="deck-load" data-deck="${id}" title="Load the selected library track, paused">LOAD</button></div>`;
}
export function deck(id,state) {
  const d=state.decks[id],t=trackById(d.trackId);
  const spin=(t.duration*(100/180)).toFixed(2);
  const readouts=`<div class="dp-read"><div><strong class="bpm-value">${bpmText(t,d.pitch)}</strong><small>${bpmNote(t)}</small></div><div><strong class="key-slot">${t.local?'—':keyBadge(t.key,'key-value')}</strong><small>KEY</small></div><div><strong data-pitch-readout="${id}">${pitchText(d.pitch)}</strong><small>PITCH</small></div></div>`;
  const platter=`<div class="platter"><svg viewBox="0 0 200 200" aria-hidden="true"><circle class="ring" cx="100" cy="100" r="96" pathLength="100"/><circle class="progress" cx="100" cy="100" r="96" pathLength="100" transform="rotate(-90 100 100)"/><circle class="disc" cx="100" cy="100" r="86"/><g class="spin"><circle class="groove" cx="100" cy="100" r="78"/><circle class="groove" cx="100" cy="100" r="68"/><circle class="groove" cx="100" cy="100" r="58"/><path class="needle" d="M100 100V18"/></g><circle class="hub" cx="100" cy="100" r="44"/></svg><div class="platter-read"><span class="elapsed">${timeLabel(d.position,true)}</span><span class="remaining">−${timeLabel(t.duration-d.position,true)}</span></div></div>`;
  const modes=`<div class="pad-bar"><div class="pad-modes" role="group" aria-label="Deck ${id} pad mode"><button data-action="pad-mode" data-deck="${id}" data-value="cue" aria-pressed="true">CUES</button><button data-action="pad-mode" data-deck="${id}" data-value="loop" aria-pressed="false">LOOP</button><button disabled title="Roll is not implemented">ROLL</button><button disabled title="Slicer is not implemented">SLICER</button></div><span class="pad-hint" data-pad-hint="cue">Shift-click stores a cue</span><span class="pad-hint" data-pad-hint="loop" hidden>Loop length in beats</span></div>`;
  return `<section class="deck deck-panel" data-deck="${id}" data-drop-deck="${id}" style="--deck:${deckColor(id)};--turns:${spin}"><header class="dp-head"><b class="deck-letter">${id}</b><div class="dp-title"><strong class="track-title">${escapeHTML(t.title)}</strong><span class="track-artist">${escapeHTML(t.artist)} · ${t.local?'Local audio':'Demo fixture'}</span></div>${readouts}</header><div class="dp-body">${platter}${transport(id,state)}${pitch(id,state)}${deckTools(id,state)}</div>${modes}${pads(id,state)}${loopPads(id,state)}</section>`;
}
export function crossfader(state) {
  return `<label class="crossfader"><span>L</span><input type="range" data-action="crossfader" min="0" max="100" value="${state.mixer.crossfader}" aria-label="Crossfader"><span>R</span></label>`;
}
const CHANNEL_ORDER=['C','A','B','D'];
export function pairSelector(state) {
  return `<div class="pair-selector" role="group" aria-label="Decks on the console">${['ab','cd'].map(pair=>`<button data-action="pair" data-value="${pair}" aria-pressed="${pair===state.pair}">${pair[0].toUpperCase()} · ${pair[1].toUpperCase()}</button>`).join('')}</div>`;
}
export function mixer(state,ids=CHANNEL_ORDER,{pair=false}={}) {
  const ordered=[...ids].sort((a,b)=>CHANNEL_ORDER.indexOf(a)-CHANNEL_ORDER.indexOf(b));
  return `<section class="mixer"><div class="mixer-top"><span>MIXER</span>${pair?pairSelector(state):''}</div><div class="channel-strips">${ordered.map(id=>`<div class="channel" data-channel="${id}" style="--deck:${deckColor(id)}"><div class="channel-title">CH ${id}</div><div class="knob-row">${knob('GAIN','gain',id,state)}${knob('FILTER','filter',id,state)}</div><div class="knob-row eq">${eqKnob('HI','hi',id,state)}${eqKnob('MID','mid',id,state)}${eqKnob('LOW','low',id,state)}</div>${assignGroup(id,state)}<div class="fader-area"><div class="vu" data-vu-deck="${id}" role="img" aria-label="Channel ${id} meter: no audio input"><i></i><i></i></div><input class="fader" type="range" data-action="deck-number" data-deck="${id}" data-field="level" min="0" max="100" value="${state.decks[id].level}" aria-label="Channel ${id} volume"><div class="vu" data-vu-deck="${id}" aria-hidden="true"><i></i><i></i></div></div><button class="channel-cue" data-action="toggle-deck" data-deck="${id}" data-field="headphone" aria-label="Monitor channel ${id}" aria-pressed="${state.decks[id].headphone}">${icon('headphones')}<span>CUE</span></button></div>`).join('')}</div><div class="crossfader-row">${crossfader(state)}</div></section>`;
}
export function effects(state) {
  return `<div class="effects">${['echo','space'].map((name,i)=>`<div class="fx-group ${i?'fx-second':''}"><span class="micro">FX 0${i+1}</span><button class="effect-name" data-action="toggle-fx" data-effect="${name}" aria-pressed="${state.mixer.effects[name].enabled}">${name.toUpperCase()}</button><label class="fx-wet"><span>WET</span><input type="range" data-action="fx-wet" data-effect="${name}" min="0" max="100" value="${state.mixer.effects[name].wet}" aria-label="${name} wet dry"></label><button class="effect-on" data-action="toggle-fx" data-effect="${name}" aria-pressed="${state.mixer.effects[name].enabled}">ON</button></div>`).join('')}<span class="fx-trailing">UI SETTINGS · ENGINE NOT CONNECTED</span></div>`;
}
const GENRE_CRATES=[['all','All tracks'],['Deep House','Deep house'],['Minimal','Minimal'],['Tech House','Peak time'],['Ambient','After hours']];
function crateButton(genre,label,state,tracks=allTracks()) {
  const count=genre==='all'?tracks.length:tracks.filter(t=>t.genre===genre).length;
  return `<button class="crate ${state.library.crate===genre?'active':''}" data-action="crate" data-value="${genre}">${escapeHTML(label)}<small>${count}</small></button>`;
}
export function library(state,{synthetic=false}={}) {
  if((globalThis.deckCraftNative||backendActive())&&!synthetic) return nativeLibrary(state);
  const tracks=synthetic?TRACKS:allTracks();
  const rail=`<aside class="collection-rail"><div class="rail-heading">COLLECTION</div>${GENRE_CRATES.map(([genre,label])=>crateButton(genre,label,state,tracks)).join('')}<div class="rail-heading second">DEMO LIBRARY</div><div class="rail-note">${icon('music')}Original synthetic tracks</div><div class="rail-bottom">No files uploaded<small>No audio engine connected</small></div></aside>`;
  const rows=tracks.map(t=>`<tr data-track-id="${t.id}" data-genre="${t.genre}" tabindex="0" draggable="true" title="Drag onto a deck or waveform, or select the row and press Alt+A/B/C/D" aria-selected="false"><td class="name-cell">${sleeve(t,'thumb')}<div><b>${escapeHTML(t.title)}</b><span>${escapeHTML(t.artist)}</span></div></td><td class="genre-cell">${t.genre}</td><td class="bpm-cell">${t.bpm.toFixed(1)}</td><td>${keyBadge(t.key)}</td><td class="time-cell">${timeLabel(t.duration)}</td></tr>`).join('');
  return `<section class="library ${state.library.dense?'tight-rows':''}">${rail}<div class="library-main"><div class="library-toolbar"><div class="library-title">Collection <span class="divider">/</span><strong class="crate-name">All tracks</strong><span class="track-count">12 tracks</span></div><label class="searchbox">${icon('search')}<input class="search" data-action="search" placeholder="Search title, artist, key" value="${escapeHTML(state.library.query)}" aria-label="Search collection"><kbd>⌘ K</kbd></label><button class="icon-btn view-toggle" data-action="density" aria-label="Toggle compact rows" aria-pressed="${state.library.dense}">${icon('list')}</button></div><p class="library-load-hint">Demo tracks only · drag a track to a deck, or select a row and press Alt+A/B/C/D</p><div class="table-wrap"><table><thead><tr><th>TRACK</th><th class="genre-cell">GENRE</th><th>BPM</th><th>KEY</th><th class="time-cell">TIME</th></tr></thead><tbody>${rows}</tbody></table><div class="empty" hidden>No matching demo tracks. <button data-action="clear-search">Clear search</button></div></div></div></section>`;
}
export function header(state) {
  const mode=(value,label)=>`<button class="deckbar-mode ${state.mode===value?'active':''}" data-action="mode" data-value="${value}" aria-pressed="${state.mode===value}">${label}</button>`;
  return `<header class="deckbar"><div class="deckbar-brand"><span class="deckbar-logo">${icon('wave')}</span><span class="deckbar-name">DECK CRAFT</span><small>UI 0.1</small></div><nav class="deckbar-modes" aria-label="Workspace">${mode('perform','Perform')}${mode('prepare','Library')}<button class="deckbar-mode canvas-entry" data-editor="open-canvas">Build</button></nav><span class="deckbar-status" role="status"></span><button class="settings-open" data-action="open-settings" aria-label="Settings" aria-haspopup="dialog" aria-expanded="false" title="Settings">${icon('cog')}</button></header>`;
}
export function dialogs(state) {
  return `<dialog class="info-dialog"><h2>Deck Craft</h2><p>Application UI foundation. One four-deck session drives the console, the library and the builder. This device remembers the session settings.</p><p>No audio engine is connected. Transport, waveforms, FX and meters are UI state or synthetic fixtures—not audio playback or analysis. Reloading restores the session paused.</p><button class="dialog-close" data-action="close-info">Back to the decks</button></dialog><dialog class="mixer-dialog"><div class="drawer-heading"><strong>Effects and cues</strong><button class="mixer-close" data-action="close-mixer" aria-label="Close effects and cues">✕</button></div><p>Shared settings for the whole session · no audio processing</p>${effects(state)}<div class="cue-editor"><strong>Store current position as a cue</strong>${DECK_IDS.map(id=>`<div><span>Deck ${id}</span>${[0,1,2,3].map(i=>`<button data-action="set-cue" data-deck="${id}" data-index="${i}" aria-label="Store deck ${id} cue ${i+1}">${i+1}</button>`).join('')}</div>`).join('')}</div></dialog>`;
}
/** Controls that used to crowd the header: theme, native audio/file actions and the effects dialog. */
export function settingsDialog(state) {
  const themes=THEMES.map(t=>`<option value="${t.id}" ${t.id===state.theme?'selected':''}>${t.name}</option>`).join('');
  const native=(globalThis.deckCraftNative||backendActive())?`<section class="settings-group settings-native" aria-labelledby="settings-audio-title"><h3 id="settings-audio-title">Audio and files</h3><p class="settings-audio-state"></p><div class="settings-actions"><button class="settings-button" data-action="reconnect-audio">Reconnect audio</button><button class="settings-button" data-action="library-import" data-kind="files">${icon('music')}Add files to library</button><button class="settings-button" data-action="library-import" data-kind="folder">${icon('folder')}Add folder to library</button><button class="settings-button" data-action="library-analyze">Analyze BPM / artwork</button><button class="settings-button native-import" data-action="import-audio">Open file → Deck ${state.library.target}</button></div></section>`:'';
  return `<dialog class="settings-dialog" aria-labelledby="settings-title"><div class="settings-head"><h2 id="settings-title">Settings</h2><button class="settings-close" data-action="close-settings" aria-label="Close settings">✕</button></div><div class="settings-body"><section class="settings-group" aria-labelledby="settings-session-title"><h3 id="settings-session-title">Session</h3><div class="settings-session"><span class="session-dot"></span>One session<span class="session-sub"> / four decks</span><span class="engine-label">NO AUDIO ENGINE</span></div><label class="settings-field"><span>Theme</span><select class="theme-picker" data-action="theme" aria-label="Theme">${themes}</select></label><p class="settings-note">UI FOUNDATION · NO AUDIO ENGINE CONNECTED</p></section>${native}<section class="settings-group" aria-labelledby="settings-tools-title"><h3 id="settings-tools-title">Tools</h3><div class="settings-actions"><button class="settings-button app-mixer" data-action="open-mixer">${icon('settings')}Effects and cues</button></div></section></div></dialog>`;
}
export function footer() {return '<footer class="statusbar"><span><i class="connected-dot"></i> UI FOUNDATION <span class="status-detail"> · Synthetic demo collection · audio engine not connected</span></span><span>FOUR DECKS · ONE SESSION</span><button data-action="open-info" class="footer-info">About / no audio</button></footer>';}
