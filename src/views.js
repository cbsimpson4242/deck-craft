import { DECK_IDS } from './catalog.js';
import { header, settingsDialog, dialogs, footer, lane, deck, mixer, library, resetAssetSequence } from './components.js';
import { renderCanvas, creatorDialog } from './canvas-view.js';

/** Presentation-only state: which pad bank each deck panel shows. */
export function createViewOptions() {return {padMode:{A:'cue',B:'cue',C:'cue',D:'cue'}};}
function stage(state) {
  return `<main class="stage"><section class="lanes" aria-label="Waveforms">${DECK_IDS.map(id=>lane(id,state)).join('')}</section><div class="console-row">${['A','C'].map(id=>deck(id,state)).join('')}${mixer(state,undefined,{pair:true})}${['B','D'].map(id=>deck(id,state)).join('')}</div>${library(state)}</main>`;
}

/** Shared components and one model; no iframe, document reload, or per-view engine. */
export function renderSession(state,ui,workspace=null,editorUI=null,history={undo:0,redo:0}) {
  resetAssetSequence();
  const custom=workspace?.active;
  const body=custom?renderCanvas(workspace,editorUI,history,state):stage(state);
  const alert=globalThis.deckCraftNative?'<div class="native-audio-bar" role="status" hidden><span class="native-audio-state"></span><button data-action="reconnect-audio">Reconnect audio</button></div>':'';
  return `<div class="app">${header(state)}<div class="persistence-warning" role="status" hidden></div>${alert}${body}${footer()}</div><div class="toast" role="status" aria-live="polite"></div>${settingsDialog(state)}${dialogs(state)}${creatorDialog()}`;
}
