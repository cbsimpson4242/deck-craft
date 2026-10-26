import { DECK_IDS, trackById } from './catalog.js';
import { header, hiddenDecks, dialogs, footer, deck, linearDeck, mixer, dock, effects, library, pads, wave, icon, escapeHTML, resetAssetSequence } from './components.js';
import { renderCanvas, creatorDialog } from './canvas-view.js';

export function createViewOptions() {return {grid:true,detail:false,cuesOpen:false,openCues:{A:false,B:false,C:false,D:false}};}
function ruler() {return `<div class="precision-ruler">${Array.from({length:12},(_,i)=>`<span>${17+Math.floor(i/4)}.${i%4+1}</span>`).join('')}</div>`;}
function alignment(state,pair='ab') {
  return `<div class="alignment">${ruler()}<div class="signal-timeline">${pair.toUpperCase().split('').map(id=>`<div class="wave-channel"><span class="wave-channel-name">${id} <i>${escapeHTML(trackById(state.decks[id].trackId).title)}</i></span>${wave(id,state)}</div>`).join('')}</div></div>`;
}
function toolbar(ui,disclosure=false) {
  return `<div class="plot-toolbar"><span class="section-label">PHRASE ALIGNMENT<i class="subtle-dot"></i><small>synthetic fixture</small></span><div class="plot-tools"><button class="grid-toggle" data-action="grid" aria-pressed="${ui.grid}">${icon('grid')}Grid</button><button class="wave-zoom" data-action="detail" aria-pressed="${ui.detail}">${icon('expand')}Detail</button>${disclosure?`<button class="cues-toggle" data-action="all-cues" aria-expanded="${ui.cuesOpen}">${icon('bookmark')}Cues</button>`:''}</div></div>`;
}
function cueRibbons(state,hidden=false) {
  return `<div class="dual-cue-ribbons" data-all-cues ${hidden?'hidden':''}>${['A','B'].map(id=>`<div style="--deck:${id==='A'?'var(--a)':'var(--b)'}"><span class="cue-ribbon-label">${id} / HOT CUES</span>${pads(id,state)}</div>`).join('')}</div>`;
}
function workspaceToolbar(title,sub) {
  return `<div class="performance-toolbar"><div><strong>${title}</strong><span>${sub}</span></div><button class="mixer-open" data-action="open-mixer">${icon('settings')}Mixer</button></div>`;
}
function signalOne(state,ui) {
  return `<main class="signal-console new-performance"><div class="signal-main"><div class="signal-deck-headers">${deck('A',state,'strip')}${deck('B',state,'strip')}</div>${toolbar(ui)}${alignment(state)}${cueRibbons(state)}</div>${mixer(state)}</main>${effects(state)}${library(state,{rail:true})}`;
}
function signalWide(state,ui) {
  return `<main class="signal-console new-performance"><div class="signal-main"><div class="signal-deck-headers">${deck('A',state,'strip')}${deck('B',state,'strip')}</div>${toolbar(ui,true)}${alignment(state)}${cueRibbons(state,!ui.cuesOpen)}</div>${dock(state)}</main>${library(state,{rail:true})}`;
}
function studio(state,ui,kind) {
  let performance;
  if(kind==='studio-grid') performance=`${workspaceToolbar('Performance','04 decks / shared session')}<div class="four-console">${DECK_IDS.map(id=>deck(id,state)).join('')}</div>`;
  if(kind==='studio-linear') performance=`${workspaceToolbar('Deck lanes','04 sources / shared session')}<div class="linear-decks">${DECK_IDS.map(id=>linearDeck(id,state,ui)).join('')}</div>`;
  if(kind==='studio-sync') performance=`<div class="sync-alignment"><div class="sync-top"><div><strong>Phrase alignment</strong><span>Synthetic pair preview</span></div><div class="pair-selector">${['ab','cd'].map(pair=>`<button data-action="pair" data-value="${pair}" aria-pressed="${pair===state.pair}">${pair[0].toUpperCase()} / ${pair[1].toUpperCase()}</button>`).join('')}</div></div>${['ab','cd'].map(pair=>`<div class="wave-group" data-group="${pair}" ${state.pair===pair?'':'hidden'}>${alignment(state,pair)}</div>`).join('')}</div><div class="four-console">${DECK_IDS.map(id=>deck(id,state)).join('')}</div>`;
  return `<main class="studio-body refinement-body">${library(state,{compact:true})}<div class="performance-column new-performance">${performance}${dock(state)}</div></main>`;
}

/** Shared components and one model; no iframe, document reload, or per-layout engine. */
export function renderSession(state,ui,workspace=null,editorUI=null,history={undo:0,redo:0}) {
  resetAssetSequence();
  const custom=workspace?.active;
  const body=custom?renderCanvas(workspace,editorUI,history,state):state.layout==='signal-one'?signalOne(state,ui):state.layout==='signal-wide'?signalWide(state,ui):studio(state,ui,state.layout);
  const top=header(state).replace('</select>','<option value="canvas">Custom canvas</option></select>').replace('</header>','<button class="canvas-entry" data-editor="open-canvas">Customize</button></header>');
  return `<div class="app">${top}<div class="persistence-warning" role="status" hidden></div>${custom?'':hiddenDecks(state)}${body}${footer()}</div><div class="toast" role="status" aria-live="polite"></div>${dialogs(state)}${creatorDialog()}`;
}
