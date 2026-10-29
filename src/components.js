import { TRACKS, LAYOUTS, THEMES, DECK_IDS, trackById, allTracks } from './catalog.js';
import { nativeLibrary } from './library.js';

export const escapeHTML = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const timeLabel = (seconds,decimal=false) => {
  const n=Math.max(0,Math.round(seconds*10));
  return String(Math.floor(n/600)).padStart(2,'0')+':'+String(Math.floor(n/10)%60).padStart(2,'0')+(decimal?'.'+n%10:'');
};
const ICONS={play:'<path d="m9 5 10 7-10 7z" fill="currentColor" stroke="none"/>',pause:'<path d="M8 5v14M16 5v14" stroke-width="4"/>',headphones:'<path d="M4 15v-3a8 8 0 0 1 16 0v3M4 13h4v7H4zM16 13h4v7h-4z"/>',wave:'<path d="M3 10v4M7 6v12M11 3v18M15 7v10M19 5v14M23 10v4"/>',settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',grid:'<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',folder:'<path d="M3 7V5h6l3 3h9v12H3z"/>',music:'<path d="M9 17V5l11-2v12M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',bookmark:'<path d="M6 3h12v18l-6-4-6 4z"/>',bolt:'<path d="m14 2-9 12h6l-1 8 9-12h-6z"/>',clock:'<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1"/>',arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',loop:'<path d="M9 7H6a5 5 0 0 0 0 10h6l6-10h-6L6 17m9 0h3a5 5 0 0 0 0-10h-6"/>',expand:'<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',skipStart:'<path d="M5 4v16m13-15L8 12l10 7Z"/>',skipEnd:'<path d="M19 4v16M6 5l10 7-10 7Z"/>',left:'<path d="m14 6-6 6 6 6"/>',right:'<path d="m10 6 6 6-6 6"/>',down:'<path d="m6 9 6 6 6-6"/>',store:'<path d="M5 18h14M12 15V4m-5 5 5-5 5 5"/>',trash:'<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>'};
export const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]||ICONS.grid}</svg>`;
let assetSequence=0;
export function resetAssetSequence(){assetSequence=0;}
export function sleeve(track,cls='') {
  const id='cover-'+(++assetSequence),i=TRACKS.indexOf(track)+1;
  return `<svg class="art ${cls}" viewBox="0 0 100 100" aria-label="${track.local?'Generated placeholder artwork for':'Synthetic sleeve for'} ${escapeHTML(track.title)}"><defs><linearGradient id="${id}" x2="1" y2="1"><stop stop-color="${track.color}"/><stop offset="1" stop-color="#18232a"/></linearGradient></defs><rect width="100" height="100" fill="url(#${id})"/><path d="M-10 70 70-10M10 110 110 10" stroke="#ffffff24" stroke-width="25"/><circle cx="50" cy="50" r="28" fill="none" stroke="#eceddf" stroke-width=".7"/><circle cx="50" cy="50" r="19" fill="none" stroke="#eceddf" stroke-width=".7"/><path d="M15 80h70M50 15v70" stroke="#eceddf80" stroke-width=".6"/><text x="9" y="15" fill="#f0f0e8" font-family="monospace" font-size="7">DC / ${String(i).padStart(3,'0')}</text></svg>`;
}
// Visual identity belongs to the deck, not the selected layout.
export const deckColor = id => ({A:'#d2fa69',B:'#64d8fa',C:'#ffbc70',D:'#c6a0ff'}[id]);
// ---- Reference deck face: waveform rendering ------------------------------------------------
// Local files draw their decoded 512-value PCM peaks, colored only by amplitude. Demo tracks use a
// deterministic synthetic fixture. Neither is frequency analysis or a beat grid.
const mulberry = seed => {let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};};
const RAMPS=[['#c52c16','#d63a19','#ad2417','#e24f1c','#bd3015'],['#be3598','#d14c9a','#a82c92','#cf3f84'],['#9650cc','#8044c1','#aa62d3','#6f3db5']];
const INTRO_COLORS=['#2fae55','#7fb82c','#d3a824','#dc7e1f','#cf4a22','#1fb2cf','#2a9ad8','#dfa02a','#c8481f'];
const CORE_COLORS=[['#ff8a34','#ff6f2a','#ffb066'],['#f08fcd','#ee7fbd'],['#c9a2ee','#b98fe6'],['#f4e08a']];
const PROFILE_COLUMNS=2048,SYNTHETIC_PULSES=70,WAVE_HEIGHT=90;
const syntheticProfiles=new Map(),peakProfiles=new WeakMap();
function syntheticProfile(index) {
  if(syntheticProfiles.has(index))return syntheticProfiles.get(index);
  const rng=mulberry(41017+index*7919),n=PROFILE_COLUMNS,amp=new Float32Array(n),zone=new Uint8Array(n),grain=new Float32Array(n);
  const gains=Array.from({length:16},()=>.5+.5*rng()),decays=Array.from({length:16},()=>2.3+2.8*rng()),offset=.12+index*.037;
  for(let i=0;i<n;i++){
    const u=i/(n-1),pulse=u*SYNTHETIC_PULSES+offset,k=Math.floor(pulse),phase=pulse-k,slot=k%16;
    const attack=.24+.76*Math.exp(-phase*decays[slot]),off=.2*Math.exp(-Math.pow((phase-.5)/.055,2))*gains[(slot+3)%16],ramp=Math.min(1,.12+phase/.025);
    const spike=rng()<.2*attack?1+.34*rng():1,jitter=phase+(rng()-.5)*.16;
    amp[i]=Math.max(.05,Math.min(1,(attack+off)*ramp*gains[slot]*(u<.215?.58:1)*spike));
    zone[i]=u<.215?3:jitter<.3?0:jitter<.58?1:2;grain[i]=rng();
  }
  const profile={amp,zone,grain,texture:true,cache:new Map(),offset};syntheticProfiles.set(index,profile);return profile;
}
function peakProfile(peaks) {
  let profile=peakProfiles.get(peaks);if(profile)return profile;
  const n=PROFILE_COLUMNS,m=peaks.length,amp=new Float32Array(n),zone=new Uint8Array(n),grain=new Float32Array(n);
  for(let i=0;i<n;i++){const x=i*(m-1)/(n-1),lo=Math.floor(x),hi=Math.min(m-1,lo+1),t=x-lo,a=peaks[lo]*(1-t)+peaks[hi]*t;amp[i]=a;zone[i]=a>.62?0:a>.34?1:2;}
  profile={amp,zone,grain,texture:false,cache:new Map()};peakProfiles.set(peaks,profile);return profile;
}
function drawColumns(profile,columns) {
  if(profile.cache.has(columns))return profile.cache.get(columns);
  const mid=WAVE_HEIGHT/2,reach=mid-2,n=profile.amp.length,step=n/columns,groups=new Map();
  const add=(color,opacity,x,up,down)=>{const key=color+'|'+opacity;let list=groups.get(key);if(!list){list=[];groups.set(key,list);}list.push(`M${x} ${(mid-up).toFixed(1)}V${(mid+down).toFixed(1)}`);};
  for(let c=0;c<columns;c++){
    const from=Math.floor(c*step),to=Math.max(from+1,Math.floor((c+1)*step));let a=0,z=0,g=.5;
    for(let j=from;j<to&&j<n;j++)if(profile.amp[j]>=a){a=profile.amp[j];z=profile.zone[j];g=profile.grain[j];}
    const color=z===3?INTRO_COLORS[Math.min(8,Math.floor(c/columns/.215*9))]:RAMPS[z][c%RAMPS[z].length],core=CORE_COLORS[z][c%CORE_COLORS[z].length];
    const ragged=profile.texture?.62+.38*g:1,up=Math.max(.6,a*reach*ragged),down=Math.max(.6,a*reach*(profile.texture?ragged:.94));
    const dropout=profile.texture&&g<(z===0?.09:z===1?.054:.03);
    if(!dropout)add(color,.92,c,up*.9,down*.9);
    add(core,.74,c,up*(profile.texture?.34:.52),down*(profile.texture?.34:.52));
    if(profile.texture){
      add(color,.7,c,up*(.2+.8*((g*7.13)%1)),down*(.2+.8*((g*3.71)%1)));
      if(z===0&&g>.975)add('#ffe3b8',.8,c,up*((g*11.3)%1),down*((g*5.9)%1));
      if(dropout)add('#050506',.6,c,up*.55,down*.55);
    }
  }
  const markup=[...groups].map(([key,list])=>{const [color,opacity]=key.split('|');return `<path data-wave-layer="column" d="${list.join('')}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="1.15" vector-effect="non-scaling-stroke"/>`;}).join('');
  profile.cache.set(columns,markup);return markup;
}
function waveRuler(track,columns,scroll,profile) {
  const line=(x,strong)=>`<path d="M${x.toFixed(1)} 0V${WAVE_HEIGHT}" stroke="#ffffff" stroke-opacity="${strong?.3:.14}" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  if(!scroll)return Array.from({length:17},(_,i)=>line(i*columns/16,i%4===0)).join('');
  if(!track.local)return Array.from({length:SYNTHETIC_PULSES+2},(_,i)=>i).map(k=>((k-profile.offset)/SYNTHETIC_PULSES)*columns).filter(x=>x>=0&&x<=columns).map((x,i)=>line(x,i%4===0)).join('');
  const every=Math.max(10,Math.ceil(track.duration/120/10)*10);let out='';
  for(let t=every;t<track.duration;t+=every)out+=line(t/track.duration*columns,t%(every*6)===0);
  return out;
}
export function paintWaveBox(box,ratio) {
  const r=Math.max(0,Math.min(1,Number.isFinite(ratio)?ratio:0));
  if(box.classList?.contains('scroll'))box.style.setProperty('--pos',String(r));
  else {const marker=box.querySelector('.position-marker');if(marker)marker.style.left=r*100+'%';}
  const shade=box.querySelector('.played-shade');if(shade)shade.style.width=r*100+'%';
}
const cueIsSet=(cue,index)=>index===0||cue>0;
export function wave(id,state,{mini=false,color=deckColor(id,state),scroll=false,overview=false}={}) {
  const deck=state.decks[id],track=trackById(deck.trackId),gradient='wave-'+(++assetSequence);
  const profile=track.local?(track.peaks.length?peakProfile(track.peaks):null):syntheticProfile(Math.max(0,TRACKS.indexOf(track)));
  const columns=scroll?PROFILE_COLUMNS:overview?640:900,ratio=deck.position/track.duration;
  const label=track.local?(track.peaks.length?'PCM amplitude waveform — not a beat grid':'PCM waveform analysis pending'):'Synthetic waveform fixture — not analyzed audio';
  const flags=mini?'':deck.cues.map((cue,i)=>`<span class="cue-flag" data-cue-flag="${i}" style="left:${cue/track.duration*100}%" ${cueIsSet(cue,i)?'':'hidden'}><b>${i+1}</b></span>`).join('');
  const svg=`<svg class="waveform" viewBox="0 0 ${columns} ${WAVE_HEIGHT}" preserveAspectRatio="none" role="img" aria-label="${label}"><defs><linearGradient id="${gradient}" x1="0" x2="1"><stop stop-color="${color}"/><stop offset="1" stop-color="${color}"/></linearGradient></defs>${profile?waveRuler(track,columns,scroll,profile)+drawColumns(profile,columns):''}<path d="M0 ${WAVE_HEIGHT/2}H${columns}" stroke="url(#${gradient})" stroke-opacity=".5" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>`;
  const classes=`wavebox ${mini?'mini':''} ${scroll?'scroll':''} ${overview?'overview':''}`;
  const seek=scroll?'':`<input class="wave-seek" type="range" data-action="deck-number" data-deck="${id}" data-field="position" min="0" max="${track.duration}" step="0.1" value="${deck.position}" aria-label="Seek deck ${id}" title="Seek UI position; no audio engine">`;
  return `<div class="${classes}" data-wave-deck="${id}" data-wave-color="${track.local?'amplitude':'fixture'}" style="--pos:${ratio};--zoom:5"><div class="wave-track">${svg}${flags}</div>${overview?`<span class="played-shade" style="width:${ratio*100}%"></span>`:''}<span class="position-marker" style="left:${ratio*100}%"></span>${seek}</div>`;
}
export function knob(label,field,id,state) {
  const value=state.decks[id][field];
  return `<label class="knob" title="Deck ${id} ${escapeHTML(label)}"><span class="dial"><i style="transform:rotate(${(value-50)*2.7}deg)"></i></span><input type="range" data-action="deck-number" data-deck="${id}" data-field="${field}" min="0" max="100" value="${value}" aria-label="Deck ${id} ${escapeHTML(label)}"><small>${escapeHTML(label)}</small></label>`;
}
const loopPresets=[4,8,16];
export function transport(id,state,compact=false) {
  const d=state.decks[id];
  const ghost=(label,why)=>`<button class="dk-ghost" disabled title="${why}">${label}</button>`;
  const extras=compact?'':`<button class="sync" data-action="toggle-deck" data-deck="${id}" data-field="sync" aria-pressed="${d.sync}">SYNC</button><button class="headphone" data-action="toggle-deck" data-deck="${id}" data-field="headphone" aria-label="Monitor deck ${id} UI state" aria-pressed="${d.headphone}">${icon('headphones')}</button>`;
  return `<div class="transport"><div class="dk-main-btns"><button class="play" data-action="toggle-deck" data-deck="${id}" data-field="playing" aria-label="${d.playing?'Pause':'Play'} deck ${id} UI transport; no audio" aria-pressed="${d.playing}">${icon(d.playing?'pause':'play')}</button><button class="cue" data-action="cue" data-deck="${id}" aria-label="Return deck ${id} to cue">CUE</button>${ghost('CUP','Cue-and-play is not implemented')}${ghost('FLX','Flux mode is not implemented')}${ghost('REV','Reverse playback is not implemented')}${extras}</div><div class="dk-loops"><div class="dk-loop-length" role="group" aria-label="Deck ${id} loop length"><button class="tiny less" data-action="loop-size" data-deck="${id}" data-factor="0.5" aria-label="Halve deck ${id} loop length">${icon('left')}</button>${loopPresets.map(n=>`<button class="loop-length" data-action="loop-length" data-deck="${id}" data-value="${n}" aria-pressed="${d.loopLength===n}" aria-label="Set deck ${id} loop length to ${n}">${n}</button>`).join('')}<button class="tiny more" data-action="loop-size" data-deck="${id}" data-factor="2" aria-label="Double deck ${id} loop length">${icon('right')}</button></div><div class="dk-loop-points"><button class="dk-ghost" disabled title="Loop in is not implemented">IN</button><button class="dk-ghost" disabled title="Loop out is not implemented">OUT</button><button class="loop" data-action="toggle-deck" data-deck="${id}" data-field="loopEnabled" aria-pressed="${d.loopEnabled}" aria-label="Loop UI state, length ${d.loopLength}">${icon('loop')}<span class="loop-len">${d.loopLength}</span></button></div></div></div>`;
}
export function pads(id,state) {
  const d=state.decks[id];
  return `<div class="pads">${d.cues.map((cue,i)=>`<button class="pad p${i} ${cueIsSet(cue,i)?'filled':''}" data-action="hot-cue" data-deck="${id}" data-index="${i}" aria-label="Deck ${id} hot cue ${i+1}; Shift-click to store position" title="Jump to cue ${i+1}. Shift-click or right-click to store current position." aria-pressed="${Math.abs(cue-d.position)<.05}"><strong>${i+1}</strong><span class="pad-name">${['INTRO','IN','DROP','BREAK'][i]}</span><small>${timeLabel(cue)}</small></button>`).join('')}${[5,6,7,8].map(n=>`<span class="pad-slot" aria-hidden="true" title="Slot ${n} is reserved; this build stores four manual cues.">${n}</span>`).join('')}</div>`;
}
const pitchText=value=>(value>=0?'+':'')+value.toFixed(1)+'%';
export function pitch(id,state,vertical=false) {
  const value=state.decks[id].pitch;
  return `<label class="pitch ${vertical?'dk-pitch':''}"><span class="pitch-label">TEMPO</span><input type="range" data-action="deck-number" data-deck="${id}" data-field="pitch" min="-8" max="8" step="0.1" value="${value}" aria-label="Deck ${id} pitch"><output>${pitchText(value)}</output></label>`;
}
function deckHead(id,state) {
  const d=state.decks[id],t=trackById(d.trackId);
  return `<div class="dk-head"><div class="dk-art">${sleeve(t)}</div><div class="dk-track"><h2 class="track-title">${escapeHTML(t.title)}</h2><p class="track-artist">${escapeHTML(t.artist)} <span>/ ${escapeHTML(t.genre)}</span></p></div><div class="dk-clock"><span class="remaining">−${timeLabel(t.duration-d.position,true)}</span><span class="elapsed">${timeLabel(d.position,true)}</span><small class="dk-kind">${t.local?'Local audio':'Demo fixture'}</small></div><div class="dk-tempo${t.local?' pending':''}"><strong class="bpm-value">${t.local?'—':t.bpm.toFixed(2)}</strong><small class="dk-key">${t.local?'analysis pending':`BPM <span class="key-value">${t.key}</span>`}</small><small class="dk-pitch-readout" data-pitch-readout="${id}">${pitchText(d.pitch)}</small></div><b class="deck-letter">${id}</b></div>`;
}
const cueToolbar=id=>`<div class="dk-edit" aria-label="Cue editing — not implemented"><button disabled aria-label="Previous cue — not implemented">${icon('skipStart')}</button><button disabled aria-label="Next cue — not implemented">${icon('skipEnd')}</button><button disabled aria-label="Cue menu — not implemented">${icon('down')}</button><span class="dk-edit-note">Shift-click a cue to store its position</span><button class="dk-type" disabled aria-label="Cue type — not implemented">Cue ${icon('down')}</button><button disabled aria-label="Move cue earlier — not implemented">${icon('left')}</button><button disabled aria-label="Store cue from toolbar — not implemented">${icon('store')}</button><button disabled aria-label="Move cue later — not implemented">${icon('right')}</button><button disabled aria-label="Delete cue — not implemented">${icon('trash')}</button><button class="dk-map" disabled title="Controller mapping is not implemented">MAP</button></div>`;
export function deck(id,state,kind='compact',color=deckColor(id,state)) {
  const d=state.decks[id],t=trackById(d.trackId),classes=`deck face ${kind} ${['A','C'].includes(id)?'a':'b'}`;
  const strip=`<div class="dk-strip"><button class="sync dk-chip" data-action="toggle-deck" data-deck="${id}" data-field="sync" aria-pressed="${d.sync}">SYNC</button><button class="dk-chip master" disabled title="Tempo master is not implemented">MASTER</button><span class="beat-dots" title="Decorative phrase fixture">● ● ● ○</span><button class="headphone dk-chip" data-action="toggle-deck" data-deck="${id}" data-field="headphone" aria-label="Monitor deck ${id} UI state" aria-pressed="${d.headphone}">${icon('headphones')}</button></div>`;
  const body=kind==='strip'?`${deckHead(id,state)}<div class="strip-middle">${pitch(id,state)}</div>${transport(id,state)}`:`${deckHead(id,state)}<div class="dk-main"><div class="dk-stack">${strip}${wave(id,state,{color,scroll:true})}<div class="dk-overview"><button class="dk-skip" data-action="cue" data-deck="${id}" aria-label="Return deck ${id} to start (cue)">${icon('skipStart')}</button>${wave(id,state,{color,overview:true})}<span class="dk-end">${timeLabel(t.duration)}</span></div></div>${pitch(id,state,true)}</div>${transport(id,state,true)}${pads(id,state)}${cueToolbar(id)}`;
  return `<section class="${classes}" data-deck="${id}" style="--deck:${color}">${body}</section>`;
}
export function linearDeck(id,state,ui) {
  const open=Boolean(ui.openCues[id]);
  return `<section class="deck face linear-deck ${['A','C'].includes(id)?'a':'b'}" data-deck="${id}" style="--deck:${deckColor(id,state)}">${deckHead(id,state)}<div class="linear-playback">${wave(id,state)}${transport(id,state)}</div><div class="linear-foot"><span class="linear-phrase">● ● ● ○ <i>Synthetic phrase fixture</i></span><button class="cues-toggle" data-action="cue-disclosure" data-deck="${id}" aria-expanded="${open}">${icon('bookmark')}Hot cues <span>4</span></button></div><div class="cue-disclosure" data-cue-panel="${id}" ${open?'':'hidden'}>${pads(id,state)}</div></section>`;
}
export function crossfader(state) {
  return `<label class="crossfader"><span>A</span><input type="range" data-action="crossfader" min="0" max="100" value="${state.mixer.crossfader}" aria-label="Crossfader"><span>B</span></label>`;
}
export function mixer(state,ids=['A','B']) {
  return `<section class="mixer"><div class="mixer-top"><span>INTERNAL MIXER</span>${icon('settings')}</div><div class="channel-strips">${ids.map(id=>`<div class="channel"><div class="channel-title">${id}<span>●</span></div>${knob('GAIN','gain',id,state)}${knob('HI','hi',id,state)}${knob('MID','mid',id,state)}${knob('LOW','low',id,state)}<div class="fader-area"><div class="vu" aria-label="No audio meter input"><i></i><i></i></div><input class="fader" type="range" data-action="deck-number" data-deck="${id}" data-field="level" min="0" max="100" value="${state.decks[id].level}" aria-label="Channel ${id} volume"><div class="fader-scale"><span>+6</span><span>0</span><span>−6</span><span>−∞</span></div></div><button class="channel-cue" data-action="toggle-deck" data-deck="${id}" data-field="headphone" aria-label="Monitor channel ${id}" aria-pressed="${state.decks[id].headphone}">${icon('headphones')}</button></div>`).join('')}</div>${crossfader(state)}<div class="cross-marks"><span>◁</span><span>THRU</span><span>▷</span></div></section>`;
}
export function dock(state) {
  const channel=id=>`<div class="dock-channel"><span class="dock-letter ${id==='B'?'b':''}">${id}</span>${knob('FILTER','filter',id,state)}<label class="dock-level">LEVEL<input type="range" data-action="deck-number" data-deck="${id}" data-field="level" min="0" max="100" value="${state.decks[id].level}" aria-label="Deck ${id} level"></label></div>`;
  return `<div class="precision-dock">${channel('A')}${crossfader(state)}${channel('B')}<button class="mixer-open" data-action="open-mixer">${icon('settings')}Mixer</button></div>`;
}
export function effects(state) {
  return `<div class="effects">${['echo','space'].map((name,i)=>`<div class="fx-group ${i?'fx-second':''}"><span class="micro">FX 0${i+1}</span><button class="effect-name" data-action="toggle-fx" data-effect="${name}" aria-pressed="${state.mixer.effects[name].enabled}">${name.toUpperCase()}</button><label class="fx-wet"><span>WET</span><input type="range" data-action="fx-wet" data-effect="${name}" min="0" max="100" value="${state.mixer.effects[name].wet}" aria-label="${name} wet dry"></label><button class="effect-on" data-action="toggle-fx" data-effect="${name}" aria-pressed="${state.mixer.effects[name].enabled}">ON</button></div>${i?'':'<div class="effect-divider"></div>'}`).join('')}<span class="fx-trailing">UI SETTINGS · ENGINE NOT CONNECTED</span></div>`;
}
function crateButton(genre,label,state,tracks=allTracks()) {
  const count=genre==='all'?tracks.length:tracks.filter(t=>t.genre===genre).length;
  return `<button class="crate ${state.library.crate===genre?'active':''}" data-action="crate" data-value="${genre}">${escapeHTML(label)}<small>${count}</small></button>`;
}
export function library(state,{rail=false,compact=false,synthetic=false}={}) {
  if(globalThis.deckCraftNative&&!synthetic) return nativeLibrary(state);
  const tracks=synthetic?TRACKS:allTracks();
  const railHTML=rail?`<aside class="collection-rail"><div class="rail-heading">COLLECTION</div>${[['all','All tracks'],['Deep House','Deep house'],['Minimal','Minimal'],['Tech House','Peak time'],['Ambient','After hours']].map(([genre,label])=>crateButton(genre,label,state,tracks)).join('')}<div class="rail-heading second">DEMO LIBRARY</div><div class="rail-note">${icon('music')}Original synthetic tracks</div><div class="rail-bottom">No files uploaded<small>No audio engine connected</small></div></aside>`:'';
  const chips=!rail?`<div class="collection-chips">${[['all','All tracks'],['Deep House','Deep house'],['Minimal','Minimal']].map(([genre,label])=>crateButton(genre,label,state,tracks)).join('')}</div>`:'';
  const rows=tracks.map((t,i)=>`<tr data-track-id="${t.id}" data-genre="${t.genre}" tabindex="0"><td class="track-no">${String(i+1).padStart(2,'0')}</td><td class="name-cell">${sleeve(t,'thumb')}<div><b>${escapeHTML(t.title)}</b><span>${escapeHTML(t.artist)}</span></div></td><td class="artist-cell">${escapeHTML(t.artist)}</td><td class="bpm-cell">${t.bpm.toFixed(2)}</td><td><span class="key key-${i%4}">${t.key}</span></td><td class="genre-cell">${t.genre}</td><td class="time-cell">${timeLabel(t.duration)}</td><td class="load-cell"><button class="load" data-action="load" data-track="${t.id}" aria-label="Load ${escapeHTML(t.title)} into selected deck">${icon('arrow')}</button></td></tr>`).join('');
  return `<section class="library ${rail?'with-rail':''} ${compact?'narrow-library':''} ${state.library.dense?'tight-rows':''}">${railHTML}<div class="library-main"><div class="library-toolbar"><div class="library-title">Collection <span class="divider">/</span><strong class="crate-name">All tracks</strong><span class="track-count">12 tracks</span></div><label class="searchbox">${icon('search')}<input class="search" data-action="search" placeholder="Search your collection" value="${escapeHTML(state.library.query)}" aria-label="Search collection"><kbd>⌘ K</kbd></label><button class="icon-btn view-toggle" data-action="density" aria-label="Toggle compact rows" aria-pressed="${state.library.dense}">${icon('list')}</button></div>${chips}<label class="load-choice">LOAD INTO <select class="load-target" data-action="load-target" aria-label="Load into deck">${DECK_IDS.map(id=>`<option value="${id}" ${id===state.library.target?'selected':''}>Deck ${id}</option>`).join('')}</select><span>Demo tracks only</span></label><div class="table-wrap"><table><thead><tr><th class="track-no">#</th><th>TITLE ↑</th><th class="artist-cell">ARTIST</th><th>BPM</th><th>KEY</th><th class="genre-cell">GENRE</th><th class="time-cell">TIME</th><th></th></tr></thead><tbody>${rows}</tbody></table><div class="empty" hidden>No matching demo tracks. <button data-action="clear-search">Clear search</button></div></div></div></section>`;
}
export function header(state) {
  return `<header class="appbar"><div class="wordmark"><span class="logo">${icon('wave')}</span>deck<span>craft</span><small>UI 0.1</small></div><nav class="mode-nav" aria-label="Workspace mode"><button class="mode ${state.mode==='perform'?'active':''}" data-action="mode" data-value="perform">Perform</button><button class="mode ${state.mode==='prepare'?'active':''}" data-action="mode" data-value="prepare">Prepare</button></nav><div class="session-name"><span class="session-dot"></span>One session<span class="session-sub"> / four decks</span></div><label class="layout-choice">LAYOUT<select class="layout-picker" data-action="layout" aria-label="Layout">${LAYOUTS.map(l=>`<option value="${l.id}" ${l.id===state.layout?'selected':''}>${l.name}</option>`).join('')}</select></label><label class="layout-choice theme-choice">THEME<select class="theme-picker" data-action="theme" aria-label="Theme">${THEMES.map(t=>`<option value="${t.id}" ${t.id===state.theme?'selected':''}>${t.name}</option>`).join('')}</select></label><div class="master-section"><span class="engine-label">NO AUDIO ENGINE</span></div><button class="icon-btn app-mixer" data-action="open-mixer" aria-label="Open four-deck mixer">${icon('settings')}</button><span class="mobile-engine-notice">UI FOUNDATION · NO AUDIO ENGINE CONNECTED</span></header>`;
}
export function hiddenDecks(state) {
  return `<aside class="hidden-decks" aria-label="Preserved decks C and D" ${LAYOUTS.find(l=>l.id===state.layout).decks===4?'hidden':''}><span class="hidden-decks-label">C / D PRESERVED</span>${['C','D'].map(id=>`<div class="hidden-deck" data-hidden-deck="${id}"><b>${id}</b><span class="hidden-track">${escapeHTML(trackById(state.decks[id].trackId).title)}</span><span class="hidden-state">${state.decks[id].playing?'UI transport on':'Paused'}</span><button data-action="toggle-deck" data-deck="${id}" data-field="playing" aria-label="${state.decks[id].playing?'Pause':'Play'} hidden deck ${id} UI transport">${icon(state.decks[id].playing?'pause':'play')}</button></div>`).join('')}<button class="show-four" data-action="show-four">Show four decks ${icon('arrow')}</button></aside>`;
}
export function dialogs(state) {
  return `<dialog class="info-dialog"><h2>Deck Craft</h2><p>Application UI foundation. All five layouts share one four-deck session. This device remembers the layout and session settings.</p><p>No audio engine is connected. Transport, waveforms, FX and meters are UI state or synthetic fixtures—not audio playback or analysis. Reloading restores the session paused.</p><button class="dialog-close" data-action="close-info">Back to the decks</button></dialog><dialog class="mixer-dialog"><div class="drawer-heading"><strong>Four-deck mixer</strong><button class="mixer-close" data-action="close-mixer" aria-label="Close mixer">✕</button></div><p>Shared settings for every layout · no audio processing</p>${mixer(state,DECK_IDS)}${effects(state)}<div class="cue-editor"><strong>Store current position as a cue</strong>${DECK_IDS.map(id=>`<div><span>Deck ${id}</span>${[0,1,2,3].map(i=>`<button data-action="set-cue" data-deck="${id}" data-index="${i}" aria-label="Store deck ${id} cue ${i+1}">${i+1}</button>`).join('')}</div>`).join('')}</div></dialog>`;
}
export function footer() {return '<footer class="statusbar"><span><i class="connected-dot"></i> UI FOUNDATION <span class="status-detail"> · Synthetic demo collection · audio engine not connected</span></span><span>ONE SESSION / FIVE LAYOUTS</span><button data-action="open-info" class="footer-info">About / no audio</button></footer>';}
