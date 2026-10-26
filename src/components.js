import { TRACKS, LAYOUTS, DECK_IDS, trackById, allTracks } from './catalog.js';

export const escapeHTML = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const timeLabel = (seconds,decimal=false) => {
  const n=Math.max(0,Math.round(seconds*10));
  return String(Math.floor(n/600)).padStart(2,'0')+':'+String(Math.floor(n/10)%60).padStart(2,'0')+(decimal?'.'+n%10:'');
};
const ICONS={play:'<path d="m9 5 10 7-10 7z" fill="currentColor" stroke="none"/>',pause:'<path d="M8 5v14M16 5v14" stroke-width="4"/>',headphones:'<path d="M4 15v-3a8 8 0 0 1 16 0v3M4 13h4v7H4zM16 13h4v7h-4z"/>',wave:'<path d="M3 10v4M7 6v12M11 3v18M15 7v10M19 5v14M23 10v4"/>',settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',grid:'<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',folder:'<path d="M3 7V5h6l3 3h9v12H3z"/>',music:'<path d="M9 17V5l11-2v12M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',bookmark:'<path d="M6 3h12v18l-6-4-6 4z"/>',bolt:'<path d="m14 2-9 12h6l-1 8 9-12h-6z"/>',clock:'<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1"/>',arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',loop:'<path d="M5 8h14l-4-4M19 16H5l4 4M19 8v4M5 16v-4"/>',expand:'<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'};
export const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]||ICONS.grid}</svg>`;
let assetSequence=0;
export function resetAssetSequence(){assetSequence=0;}
export function sleeve(track,cls='') {
  const id='cover-'+(++assetSequence),i=TRACKS.indexOf(track)+1;
  return `<svg class="art ${cls}" viewBox="0 0 100 100" aria-label="${track.local?'Generated placeholder artwork for':'Synthetic sleeve for'} ${escapeHTML(track.title)}"><defs><linearGradient id="${id}" x2="1" y2="1"><stop stop-color="${track.color}"/><stop offset="1" stop-color="#18232a"/></linearGradient></defs><rect width="100" height="100" fill="url(#${id})"/><path d="M-10 70 70-10M10 110 110 10" stroke="#ffffff24" stroke-width="25"/><circle cx="50" cy="50" r="28" fill="none" stroke="#eceddf" stroke-width=".7"/><circle cx="50" cy="50" r="19" fill="none" stroke="#eceddf" stroke-width=".7"/><path d="M15 80h70M50 15v70" stroke="#eceddf80" stroke-width=".6"/><text x="9" y="15" fill="#f0f0e8" font-family="monospace" font-size="7">DC / ${String(i).padStart(3,'0')}</text></svg>`;
}
// Visual identity belongs to the deck, not the selected layout.
export const deckColor = id => ({A:'#d2fa69',B:'#64d8fa',C:'#ffbc70',D:'#c6a0ff'}[id]);
const waveCache=new Map();
function wavePaths(seed) {
  if(waveCache.has(seed)) return waveCache.get(seed);
  let randomState=seed+31;
  const random=()=>{randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;return randomState/4294967296;};
  const shapes=[0,1].map(layer=>{
    const n=420,values=[];
    for(let j=0;j<n;j++){
      const beat=((j+seed*7)%(n/16))/(n/16),phrase=.55+.22*Math.sin(j*.016+seed)+.2*Math.sin(j*.049);
      values.push(Math.max(1,Math.min(40,(Math.exp(-beat*10)*.65+.13+random()*.6)*phrase*(layer===0?42:25))));
    }
    const top=values.map((h,j)=>`${(j*1000/(n-1)).toFixed(1)},${(45-h).toFixed(1)}`).join(' ');
    const bottom=values.map((h,j)=>`${(j*1000/(n-1)).toFixed(1)},${(45+h*.86).toFixed(1)}`).reverse().join(' ');
    return `M${top} L${bottom}Z`;
  });
  waveCache.set(seed,shapes);return shapes;
}
function pcmWavePaths(peaks) {
 if(!peaks?.length)return ['',''];
 const top=peaks.map((h,i)=>`${(i*1000/(peaks.length-1)).toFixed(1)},${(45-h*42).toFixed(2)}`).join(' ');
 const bottom=peaks.map((h,i)=>`${(i*1000/(peaks.length-1)).toFixed(1)},${(45+h*42).toFixed(2)}`).reverse().join(' ');
 return [`M${top} L${bottom}Z`,''];
}
export function wave(id,state,{mini=false}={}) {
  const deck=state.decks[id],track=trackById(deck.trackId),color=deckColor(id,state),gradient='wave-'+(++assetSequence),paths=track.local?pcmWavePaths(track.peaks):wavePaths(TRACKS.indexOf(track));
  const grid=Array.from({length:17},(_,i)=>`<path d="M${i*62.5} 0V90" stroke="#ffffff" stroke-opacity="${i%4===0?.17:.065}"/>`).join('');
  const flags=mini?'':deck.cues.slice(1,3).map((cue,i)=>`<span class="wave-flag" data-cue-flag="${i+1}" style="left:${cue/track.duration*100}%;background:${color}">${String(i+2).padStart(2,'0')} ${track.local?'CUE':i===0?'IN':'DROP'}</span>`).join('');
  return `<div class="wavebox ${mini?'mini':''}" data-wave-deck="${id}"><svg class="waveform" viewBox="0 0 1000 90" preserveAspectRatio="none" role="img" aria-label="${track.local?(track.peaks.length?'PCM amplitude waveform — not a beat grid':'PCM waveform analysis pending'):'Synthetic waveform fixture — not analyzed audio'}"><defs><linearGradient id="${gradient}" x1="0" y1="1" x2="0" y2="0"><stop stop-color="#235b87"/><stop offset=".38" stop-color="${color}"/><stop offset=".65" stop-color="${color}"/><stop offset="1" stop-color="#c2ece0"/></linearGradient></defs>${grid}<path d="${paths[0]}" fill="url(#${gradient})" opacity=".9"/><path d="${paths[1]}" fill="${color}" opacity=".5"/></svg>${flags}<span class="position-marker" style="left:${deck.position/track.duration*100}%"></span><input class="wave-seek" type="range" data-action="deck-number" data-deck="${id}" data-field="position" min="0" max="${track.duration}" step="0.1" value="${deck.position}" aria-label="Seek deck ${id}" title="Seek UI position; no audio engine"></div>`;
}
export function knob(label,field,id,state) {
  const value=state.decks[id][field];
  return `<label class="knob" title="Deck ${id} ${escapeHTML(label)}"><span class="dial"><i style="transform:rotate(${(value-50)*2.7}deg)"></i></span><input type="range" data-action="deck-number" data-deck="${id}" data-field="${field}" min="0" max="100" value="${value}" aria-label="Deck ${id} ${escapeHTML(label)}"><small>${escapeHTML(label)}</small></label>`;
}
export function transport(id,state) {
  const d=state.decks[id];
  return `<div class="transport"><button class="cue" data-action="cue" data-deck="${id}" aria-label="Return deck ${id} to cue">CUE</button><button class="play" data-action="toggle-deck" data-deck="${id}" data-field="playing" aria-label="${d.playing?'Pause':'Play'} deck ${id} UI transport; no audio" aria-pressed="${d.playing}">${icon(d.playing?'pause':'play')}</button><button class="sync" data-action="toggle-deck" data-deck="${id}" data-field="sync" aria-pressed="${d.sync}">SYNC</button><button class="headphone" data-action="toggle-deck" data-deck="${id}" data-field="headphone" aria-label="Monitor deck ${id} UI state" aria-pressed="${d.headphone}">${icon('headphones')}</button><span class="transport-gap"></span><button class="loop" data-action="toggle-deck" data-deck="${id}" data-field="loopEnabled" aria-pressed="${d.loopEnabled}">${icon('loop')}<span>${d.loopLength}</span></button><button class="tiny less" data-action="loop-size" data-deck="${id}" data-factor="0.5" aria-label="Halve deck ${id} loop length">−</button><button class="tiny more" data-action="loop-size" data-deck="${id}" data-factor="2" aria-label="Double deck ${id} loop length">+</button></div>`;
}
export function pads(id,state) {
  return `<div class="pads">${state.decks[id].cues.map((cue,i)=>`<button class="pad p${i}" data-action="hot-cue" data-deck="${id}" data-index="${i}" aria-label="Deck ${id} hot cue ${i+1}; Shift-click to store position" title="Jump to cue ${i+1}. Shift-click or right-click to store current position." aria-pressed="${Math.abs(cue-state.decks[id].position)<.05}"><strong>${i+1}</strong><span>${['INTRO','IN','DROP','BREAK'][i]}</span><small>${timeLabel(cue)}</small></button>`).join('')}</div>`;
}
export function pitch(id,state) {
  return `<label class="pitch">TEMPO<input type="range" data-action="deck-number" data-deck="${id}" data-field="pitch" min="-8" max="8" step="0.1" value="${state.decks[id].pitch}" aria-label="Deck ${id} pitch"><output>${state.decks[id].pitch>=0?'+':''}${state.decks[id].pitch.toFixed(1)}%</output></label>`;
}
function deckMeta(id,state) {
  const d=state.decks[id],t=trackById(d.trackId);
  return `<div class="deck-meta"><span class="deck-letter">${id}</span>${sleeve(t)}<div class="track-copy"><h2 class="track-title">${escapeHTML(t.title)}</h2><p class="track-artist">${escapeHTML(t.artist)} <span>/ ${escapeHTML(t.genre)}</span></p></div><div class="bpm"><strong class="bpm-value">${t.bpm.toFixed(2)}</strong><small>BPM <span class="key-value">${t.key}</span></small></div></div>`;
}
export function deck(id,state,kind='compact') {
  const d=state.decks[id],t=trackById(d.trackId),classes=`deck ${kind} ${['A','C'].includes(id)?'a':'b'}`;
  const time=`<div class="deck-time"><span class="elapsed">${timeLabel(d.position,true)}</span><span class="beat-dots" title="Decorative phrase fixture">● ● ● ○</span><span class="remaining">−${timeLabel(t.duration-d.position,true)}</span></div>`;
  const body=kind==='strip'?`${deckMeta(id,state)}<div class="strip-middle"><div class="remaining">−${timeLabel(t.duration-d.position,true)}</div>${pitch(id,state)}</div>${transport(id,state)}`:`${deckMeta(id,state)}${wave(id,state)}${time}${transport(id,state)}${pads(id,state)}`;
  return `<section class="${classes}" data-deck="${id}" style="--deck:${deckColor(id,state)}">${body}</section>`;
}
export function linearDeck(id,state,ui) {
  const d=state.decks[id],t=trackById(d.trackId),open=Boolean(ui.openCues[id]);
  return `<section class="deck linear-deck ${['A','C'].includes(id)?'a':'b'}" data-deck="${id}" style="--deck:${deckColor(id,state)}"><div class="linear-meta"><span class="deck-letter">${id}</span>${sleeve(t)}<div class="track-copy"><h2 class="track-title">${escapeHTML(t.title)}</h2><p class="track-artist">${escapeHTML(t.artist)}</p></div><div class="linear-clock"><span class="remaining">−${timeLabel(t.duration-d.position,true)}</span><span class="elapsed">${timeLabel(d.position,true)} / ${timeLabel(t.duration)}</span></div><div class="bpm"><strong class="bpm-value">${t.bpm.toFixed(2)}</strong><small>BPM <span class="key-value">${t.key}</span></small></div></div><div class="linear-playback">${wave(id,state)}${transport(id,state)}</div><div class="linear-foot"><span class="linear-phrase">● ● ● ○ <i>Synthetic phrase fixture</i></span><button class="cues-toggle" data-action="cue-disclosure" data-deck="${id}" aria-expanded="${open}">${icon('bookmark')}Hot cues <span>4</span></button></div><div class="cue-disclosure" data-cue-panel="${id}" ${open?'':'hidden'}>${pads(id,state)}</div></section>`;
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
function crateButton(genre,label,state) {
  const count=genre==='all'?allTracks().length:allTracks().filter(t=>t.genre===genre).length;
  return `<button class="crate ${state.library.crate===genre?'active':''}" data-action="crate" data-value="${genre}">${escapeHTML(label)}<small>${count}</small></button>`;
}
export function library(state,{rail=false,compact=false}={}) {
  const railHTML=rail?`<aside class="collection-rail"><div class="rail-heading">COLLECTION</div>${[['all','All tracks'],['Deep House','Deep house'],['Minimal','Minimal'],['Tech House','Peak time'],['Ambient','After hours']].map(([genre,label])=>crateButton(genre,label,state)).join('')}<div class="rail-heading second">DEMO LIBRARY</div><div class="rail-note">${icon('music')}Original synthetic tracks</div><div class="rail-bottom">No files uploaded<small>No audio engine connected</small></div></aside>`:'';
  const chips=!rail?`<div class="collection-chips">${[['all','All tracks'],['Deep House','Deep house'],['Minimal','Minimal']].map(([genre,label])=>crateButton(genre,label,state)).join('')}</div>`:'';
  const rows=allTracks().map((t,i)=>`<tr data-track-id="${t.id}" data-genre="${t.genre}" tabindex="0"><td class="track-no">${String(i+1).padStart(2,'0')}</td><td class="name-cell">${sleeve(t,'thumb')}<div><b>${escapeHTML(t.title)}</b><span>${escapeHTML(t.artist)}</span></div></td><td class="artist-cell">${escapeHTML(t.artist)}</td><td class="bpm-cell">${t.bpm.toFixed(2)}</td><td><span class="key key-${i%4}">${t.key}</span></td><td class="genre-cell">${t.genre}</td><td class="time-cell">${timeLabel(t.duration)}</td><td class="load-cell"><button class="load" data-action="load" data-track="${t.id}" aria-label="Load ${escapeHTML(t.title)} into selected deck">${icon('arrow')}</button></td></tr>`).join('');
  return `<section class="library ${rail?'with-rail':''} ${compact?'narrow-library':''} ${state.library.dense?'tight-rows':''}">${railHTML}<div class="library-main"><div class="library-toolbar"><div class="library-title">Collection <span class="divider">/</span><strong class="crate-name">All tracks</strong><span class="track-count">12 tracks</span></div><label class="searchbox">${icon('search')}<input class="search" data-action="search" placeholder="Search your collection" value="${escapeHTML(state.library.query)}" aria-label="Search collection"><kbd>⌘ K</kbd></label><button class="icon-btn view-toggle" data-action="density" aria-label="Toggle compact rows" aria-pressed="${state.library.dense}">${icon('list')}</button></div>${chips}<label class="load-choice">LOAD INTO <select class="load-target" data-action="load-target" aria-label="Load into deck">${DECK_IDS.map(id=>`<option value="${id}" ${id===state.library.target?'selected':''}>Deck ${id}</option>`).join('')}</select><span>Demo tracks only</span></label><div class="table-wrap"><table><thead><tr><th class="track-no">#</th><th>TITLE ↑</th><th class="artist-cell">ARTIST</th><th>BPM</th><th>KEY</th><th class="genre-cell">GENRE</th><th class="time-cell">TIME</th><th></th></tr></thead><tbody>${rows}</tbody></table><div class="empty" hidden>No matching demo tracks. <button data-action="clear-search">Clear search</button></div></div></div></section>`;
}
export function header(state) {
  return `<header class="appbar"><div class="wordmark"><span class="logo">${icon('wave')}</span>deck<span>craft</span><small>UI 0.1</small></div><nav class="mode-nav" aria-label="Workspace mode"><button class="mode ${state.mode==='perform'?'active':''}" data-action="mode" data-value="perform">Perform</button><button class="mode ${state.mode==='prepare'?'active':''}" data-action="mode" data-value="prepare">Prepare</button></nav><div class="session-name"><span class="session-dot"></span>One session<span class="session-sub"> / four decks</span></div><label class="layout-choice">LAYOUT<select class="layout-picker" data-action="layout" aria-label="Layout">${LAYOUTS.map(l=>`<option value="${l.id}" ${l.id===state.layout?'selected':''}>${l.name}</option>`).join('')}</select></label><div class="master-section"><span class="engine-label">NO AUDIO ENGINE</span></div><button class="icon-btn app-mixer" data-action="open-mixer" aria-label="Open four-deck mixer">${icon('settings')}</button><span class="mobile-engine-notice">UI FOUNDATION · NO AUDIO ENGINE CONNECTED</span></header>`;
}
export function hiddenDecks(state) {
  return `<aside class="hidden-decks" aria-label="Preserved decks C and D" ${LAYOUTS.find(l=>l.id===state.layout).decks===4?'hidden':''}><span class="hidden-decks-label">C / D PRESERVED</span>${['C','D'].map(id=>`<div class="hidden-deck" data-hidden-deck="${id}"><b>${id}</b><span class="hidden-track">${escapeHTML(trackById(state.decks[id].trackId).title)}</span><span class="hidden-state">${state.decks[id].playing?'UI transport on':'Paused'}</span><button data-action="toggle-deck" data-deck="${id}" data-field="playing" aria-label="${state.decks[id].playing?'Pause':'Play'} hidden deck ${id} UI transport">${icon(state.decks[id].playing?'pause':'play')}</button></div>`).join('')}<button class="show-four" data-action="show-four">Show four decks ${icon('arrow')}</button></aside>`;
}
export function dialogs(state) {
  return `<dialog class="info-dialog"><h2>Deck Craft</h2><p>Application UI foundation. All five layouts share one four-deck session. This device remembers the layout and session settings.</p><p>No audio engine is connected. Transport, waveforms, FX and meters are UI state or synthetic fixtures—not audio playback or analysis. Reloading restores the session paused.</p><button class="dialog-close" data-action="close-info">Back to the decks</button></dialog><dialog class="mixer-dialog"><div class="drawer-heading"><strong>Four-deck mixer</strong><button class="mixer-close" data-action="close-mixer" aria-label="Close mixer">✕</button></div><p>Shared settings for every layout · no audio processing</p>${mixer(state,DECK_IDS)}${effects(state)}<div class="cue-editor"><strong>Store current position as a cue</strong>${DECK_IDS.map(id=>`<div><span>Deck ${id}</span>${[0,1,2,3].map(i=>`<button data-action="set-cue" data-deck="${id}" data-index="${i}" aria-label="Store deck ${id} cue ${i+1}">${i+1}</button>`).join('')}</div>`).join('')}</div></dialog>`;
}
export function footer() {return '<footer class="statusbar"><span><i class="connected-dot"></i> UI FOUNDATION <span class="status-detail"> · Synthetic demo collection · audio engine not connected</span></span><span>ONE SESSION / FIVE LAYOUTS</span><button data-action="open-info" class="footer-info">About / no audio</button></footer>';}
