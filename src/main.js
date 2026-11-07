import { DECK_IDS, LAYOUTS, trackById, setBackendActive } from './catalog.js';
import { createBrowserBridge } from './browser-audio.js';
import { NativeSession, restoreNativeCatalog } from './native.js';
import { createStore } from './store.js';
import { createViewOptions, renderSession } from './views.js';
import { icon, timeLabel, paintKnob } from './components.js';
import { LibraryController, orderedLibraryTracks } from './library.js';
import { CanvasEditor } from './canvas-editor.js';
import { WaveZoom } from './wave-zoom.js';
import { TransportPainter } from './frame.js';
import { WaveGesture } from './wave-input.js';
import { TrackDragLoader } from './drag-load.js';

const root=document.getElementById('app');
// The native desktop bridge is authoritative when present; otherwise the page may use its own browser backend.
const hostBridge=globalThis.deckCraftNative||null;
const browserHost=hostBridge?null:await createBrowserBridge(globalThis);
const nativeBridge=hostBridge||browserHost?.bridge||null;
setBackendActive(nativeBridge?(nativeBridge.backend?.id||'native'):null);
const nativeWarning=await restoreNativeCatalog(nativeBridge);
let nativeAudio=null;
let libraryUI=null;
let editor=null;
let painter=null,gestures=null;
const store=createStore({getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)});
const options=Object.fromEntries(LAYOUTS.map(layout=>[layout.id,createViewOptions()]));
const waveZoom=new WaveZoom(root,()=>{gestures?.cancelAll();painter?.refresh();});
const $=(selector,parent=root)=>[...parent.querySelectorAll(selector)].find(el=>!el.closest('.design-preview'));
const $$=(selector,parent=root)=>[...parent.querySelectorAll(selector)].filter(el=>!el.closest('.design-preview'));
let toastTimer;let selectedTrack=null;
function toast(message,ms=2800) {
  clearTimeout(toastTimer);const target=$('.toast');target.textContent=message;
  toastTimer=setTimeout(()=>{const current=$('.toast');if(current)current.textContent='';},ms);
}
let shownWarning=null;
function paintWarning(force=false){
  const text=[store.getWarning(),nativeAudio?.warning].filter(Boolean).join(' ');
  if(!force&&text===shownWarning)return;shownWarning=text;
  const el=$('.persistence-warning');if(el){el.hidden=!text;el.textContent=text;root.dataset.saved=text?'false':'true';}
}
function updateTransport(){
  const state=store.get();
  for(const id of DECK_IDS){const d=state.decks[id];
    $$(`section.deck[data-deck="${id}"]`).forEach(el=>el.classList.toggle('playing',d.playing));
    $$(`.channel[data-channel="${id}"]`).forEach(el=>el.classList.toggle('playing',d.playing));
    $$(`[data-field="playing"][data-deck="${id}"]`).forEach(button=>{
      button.setAttribute('aria-pressed',String(d.playing));
      if(button.dataset.on!==String(d.playing)){button.dataset.on=String(d.playing);button.innerHTML=icon(d.playing?'pause':'play')+'<span>'+(d.playing?'PAUSE':'PLAY')+'</span>';}
    });
  }
  nativeAudio?.paintTransport();
}
function update({paint=true}={}) {
  const state=store.get(),ui=options[state.layout],layout=LAYOUTS.find(l=>l.id===state.layout);
  const custom=store.getWorkspace().active;
  document.body.className=(custom?'canvas-mode':layout.classes)+' engine-off'+(state.mode==='prepare'?' prepare-mode':'');
  document.body.dataset.theme=state.theme;
  root.dataset.layout=custom?'canvas':state.layout;root.dataset.pair=state.pair;
  document.title='Deck Craft — '+(custom?'Build':state.mode==='prepare'?'Library':'Perform');
  $$('.theme-picker').forEach(select=>{select.value=state.theme;});
  $$('.deckbar-mode').forEach(button=>{const on=!custom&&button.dataset.value===state.mode;button.classList.toggle('active',on);button.setAttribute('aria-pressed',String(on));});
  $$('.canvas-entry').forEach(button=>{button.classList.toggle('active',Boolean(custom));button.setAttribute('aria-pressed',String(Boolean(custom)));});
  paintWarning(true);
  for(const id of DECK_IDS) {
    const d=state.decks[id],track=trackById(d.trackId);
    $$(`section.deck[data-deck="${id}"]`).forEach(section=>{
      $$('.remaining',section).forEach(el=>el.textContent='−'+timeLabel(track.duration-d.position,true));
      $$('.elapsed',section).forEach(el=>el.textContent=timeLabel(d.position,true)+(el.closest('.linear-clock')?' / '+timeLabel(track.duration):''));
      section.classList.toggle('playing',d.playing);
    });
    $$(`[data-action="toggle-deck"][data-deck="${id}"]`).forEach(button=>{
      const on=d[button.dataset.field];button.setAttribute('aria-pressed',String(on));
      if(button.classList.contains('play')) {button.innerHTML=icon(on?'pause':'play')+'<span>'+(on?'PAUSE':'PLAY')+'</span>';button.setAttribute('aria-label',(on?'Pause':'Play')+' deck '+id+' UI transport; no audio');}
      if(button.classList.contains('loop')) {const length=$('.loop-len',button);if(length)length.textContent=d.loopLength;}
    });
    $$(`[data-action="deck-number"][data-deck="${id}"]`).forEach(input=>{
      const value=d[input.dataset.field];if(Number(input.value)!==value&&(!nativeAudio||document.activeElement!==input))input.value=value;
      const label=input.closest('label');
      if(label?.classList.contains('knob')) paintKnob(label,id,input.dataset.field,value);
      if(label?.classList.contains('pitch')) $('output',label).textContent=(value>=0?'+':'')+value.toFixed(1)+'%';
    });
    $$(`[data-action="hot-cue"][data-deck="${id}"]`).forEach(button=>{
      const index=Number(button.dataset.index),cue=d.cues[index];$('small',button).textContent=timeLabel(cue);button.setAttribute('aria-pressed',String(Math.abs(cue-d.position)<.05));button.classList.toggle('filled',index===0||cue>0);
    });
    $$(`[data-action="loop-length"][data-deck="${id}"]`).forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.value)===d.loopLength)));
    $$(`[data-pitch-readout="${id}"]`).forEach(el=>el.textContent=(d.pitch>=0?'+':'')+d.pitch.toFixed(1)+'%');
    $$(`[data-wave-deck="${id}"]`).forEach(box=>{
      waveZoom.paint(box);

      $$('[data-cue-flag]',box).forEach(flag=>{const index=Number(flag.dataset.cueFlag),cue=d.cues[index];flag.style.left=cue/track.duration*100+'%';flag.hidden=!(index===0||cue>0);});
    });
    $$(`.channel[data-channel="${id}"]`).forEach(channel=>channel.classList.toggle('playing',d.playing));
  }
  $$('[data-action="crossfader"]').forEach(input=>{if(!nativeAudio||document.activeElement!==input)input.value=state.mixer.crossfader;});
  for(const effect of ['echo','space']) {
    $$(`[data-action="toggle-fx"][data-effect="${effect}"]`).forEach(button=>button.setAttribute('aria-pressed',String(state.mixer.effects[effect].enabled)));
    $$(`[data-action="fx-wet"][data-effect="${effect}"]`).forEach(input=>input.value=state.mixer.effects[effect].wet);
  }
  $$('.library').forEach(el=>el.classList.toggle('tight-rows',state.library.dense));
  $$('.view-toggle').forEach(el=>el.setAttribute('aria-pressed',String(state.library.dense)));
  $$('.search').forEach(el=>{if(el.value!==state.library.query)el.value=state.library.query;});
  $$('[data-action="master"]').forEach(el=>el.setAttribute('aria-pressed',String(state.master===el.dataset.deck)));
  $$('.load-target').forEach(el=>el.value=state.library.target);
  const query=state.library.query.toLowerCase();
  const localOrder=nativeAudio?orderedLibraryTracks(state,{unfiltered:true}):null,localVisible=new Set(localOrder?.map(t=>t.id));
  $$('tr[data-track-id]').forEach(row=>{
    const track=trackById(row.dataset.trackId),matches=nativeAudio?localVisible.has(track.id):(state.library.crate==='all'||track.genre===state.library.crate)&&[track.title,track.artist,track.genre,track.key,track.bpm].join(' ').toLowerCase().includes(query);
    row.hidden=!matches;
    if(!nativeAudio)row.classList.toggle('selected',row.dataset.trackId===selectedTrack);
    $('.load',row)?.setAttribute('aria-label','Load '+track.title+' into deck '+state.library.target);
  });
  $$('.library').forEach(el=>{const count=$$('tr[data-track-id]:not([hidden])',el).length;const counter=$('.track-count',el);if(counter)counter.textContent=count+(count===1?' track':' tracks');$('.empty',el).hidden=count!==0;});
  $$('.crate-name').forEach(el=>el.textContent=state.library.crate==='all'?'All tracks':state.library.crate);
  $$('.crate').forEach(button=>button.classList.toggle('active',button.dataset.value===state.library.crate));
  if(localOrder)for(const table of $$('.library tbody')) {
    const rows=$$('tr[data-track-id]',table).filter(row=>localVisible.has(row.dataset.trackId));
    const byId=new Map(rows.map(row=>[row.dataset.trackId,row]));
    const sorted=localOrder.map(track=>byId.get(track.id)).filter(Boolean);
    // Native clock updates must not detach the source of a live library drag.
    if(sorted.some((row,index)=>row!==rows[index]))for(const row of sorted)table.append(row);
  }
  $$('[data-action="pad-mode"]').forEach(button=>button.setAttribute('aria-pressed',String(ui.padMode[button.dataset.deck]===button.dataset.value)));
  $$('section.deck-panel [data-pad-panel]').forEach(panel=>panel.hidden=ui.padMode[panel.dataset.padDeck]!==panel.dataset.padPanel);
  $$('section.deck-panel [data-pad-hint]').forEach(hint=>hint.hidden=ui.padMode[hint.closest('section.deck-panel').dataset.deck]!==hint.dataset.padHint);
  $$('[data-action="pair"]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.value===state.pair)));
  nativeAudio?.paint();
  libraryUI?.paint();
  if(!nativeAudio&&browserHost&&!browserHost.support.supported){const detail=$('.status-detail');if(detail)detail.textContent=' · Synthetic demo collection · browser audio unavailable here (missing: '+browserHost.support.reasons.join(', ')+')';}
  if(paint)painter.refresh();
}
// The settings dialog is DOM, so a re-render must restore its open state and focus (no reload, no session change).
const SETTINGS_FOCUSABLE='button:not([hidden]),select,input,[href]';
const programmaticSettingsClose=new WeakSet();
function settingsToken(el) {
  const dialog=el?.closest?.('.settings-dialog');
  if(dialog?.open)return {settings:[...dialog.querySelectorAll(SETTINGS_FOCUSABLE)].indexOf(el)};
  return el?.classList?.contains('settings-open')?{cog:true}:null;
}
function openSettings() {
  const dialog=$('.settings-dialog');if(!dialog||dialog.open)return;
  dialog.showModal();$('.settings-open')?.setAttribute('aria-expanded','true');
}
function closeSettings(focus=true) {
  const dialog=$('.settings-dialog'),cog=$('.settings-open');
  if(dialog?.open){programmaticSettingsClose.add(dialog);dialog.close();}
  cog?.setAttribute('aria-expanded','false');
  if(focus)cog?.focus({preventScroll:true});
}
function mount() {
  const token=settingsToken(document.activeElement),wasOpen=Boolean($('.settings-dialog')?.open);
  gestures?.cancelAll();
  editor?.beforeMount();
  root.innerHTML=renderSession(store.get(),options[store.get().layout],store.getWorkspace(),editor?.ui,store.getWorkspaceHistory());painter.invalidate();update({paint:false});painter.refresh();
  editor?.afterMount();
  const dialog=$('.settings-dialog');
  if(wasOpen&&dialog){dialog.showModal();$('.settings-open')?.setAttribute('aria-expanded','true');}
  if(token?.cog)$('.settings-open')?.focus({preventScroll:true});
  else if(token&&wasOpen&&dialog)[...dialog.querySelectorAll(SETTINGS_FOCUSABLE)][Math.max(0,token.settings)]?.focus({preventScroll:true});
}
// Engine receipts repaint only the cached clocks, waveforms and meters. The few state changes a receipt can
// carry that other controls display (tempo master, tempo, pitch lock and sync) also refresh those controls once.
const tempoSignature=state=>state.master+'|'+DECK_IDS.map(id=>{const d=state.decks[id];return d.pitch+','+d.pitchLock+','+d.sync;}).join(';');
let tempoKey=tempoSignature(store.get());
store.subscribe((state,action)=>{
  if(action.type==='native-clock'){painter.mark();paintWarning();const key=tempoSignature(state);if(key!==tempoKey){tempoKey=key;update();}return;}
  tempoKey=tempoSignature(state);
  if(['layout','load','workspace'].includes(action.type))mount();else update();
});
// Canvas waveforms are sized to the box in device pixels, so a resize repaints them.
let resizeFrame=0;window.addEventListener('resize',()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>painter.refresh());});
function dispatch(action){if(!nativeAudio?.dispatch(action))store.dispatch(action);}
/** The Load arrow and library-row drops share one load action. */
function loadTrack(deck,trackId){dispatch({type:'load',deck,trackId});if(!nativeAudio)toast('Demo track loaded into deck '+deck+'. Waveform is synthetic; no audio is loaded.');}

// Settings: backdrop click, Customize, and actions that hand control to another surface close the dialog first.
root.addEventListener('click',event=>{
  if(event.target.matches('.settings-dialog'))closeSettings();
  else if(event.target.closest('.settings-dialog [data-editor="open-canvas"]'))closeSettings(false);
});
root.addEventListener('close',event=>{
  if(!event.target.matches?.('.settings-dialog'))return;
  if(programmaticSettingsClose.delete(event.target))return;
  $('.settings-open')?.setAttribute('aria-expanded','false');$('.settings-open')?.focus({preventScroll:true});
},true);
const LEAVES_SETTINGS=new Set(['open-mixer','show-four','import-audio','library-import']);
root.addEventListener('click',event=>{
  const row=event.target.closest('tr[data-track-id]');if(row&&!event.target.closest('button,input,select')){selectedTrack=row.dataset.trackId;libraryUI?.selectRow(row,event);if(!libraryUI)update();}
  const target=event.target.closest('button[data-action]');if(!target||!root.contains(target))return;
  if(LEAVES_SETTINGS.has(target.dataset.action)&&target.closest('.settings-dialog[open]'))closeSettings();
  if(libraryUI?.handleClick(target))return;
  const state=store.get(),ui=options[state.layout],id=target.dataset.deck,field=target.dataset.field;
  switch(target.dataset.action) {
    case 'master':dispatch({type:'master',deck:id});break;
    case 'deck-load':{const trackId=libraryUI?.lastSelected||selectedTrack;if(trackId)loadTrack(id,trackId);else toast('Select a library track first.');break;}
    case 'import-audio':nativeAudio?.importAudio(store.get().library.target);break;
    case 'reconnect-audio':nativeAudio?.reconnect();break;
    case 'mode':if(store.getWorkspace().active)store.dispatchWorkspace({type:'active',value:false});dispatch({type:'mode',value:target.dataset.value});break;
    case 'toggle-deck':dispatch({type:'deck',deck:id,field,value:!state.decks[id][field]});if(field==='playing'&&!nativeAudio)toast('Transport UI state only — no audio engine is connected.');break;
    case 'eq-kill':dispatch({type:'eq-kill',deck:id,band:target.dataset.band,kill:state.decks[id][target.dataset.band]>0});break;
    case 'assign':dispatch({type:'assign',deck:id,value:target.dataset.value});break;
    case 'cue':dispatch({type:'cue',deck:id});break;
    case 'loop-length':dispatch({type:'deck',deck:id,field:'loopLength',value:Number(target.dataset.value)});break;
    case 'loop-size':dispatch({type:'deck',deck:id,field:'loopLength',value:Math.max(1,Math.min(32,state.decks[id].loopLength*Number(target.dataset.factor)))});break;
    case 'hot-cue':dispatch({type:event.shiftKey?'setCue':'hotCue',deck:id,index:Number(target.dataset.index)});if(event.shiftKey)toast('Cue stored at the current UI position.');break;
    case 'set-cue':dispatch({type:'setCue',deck:id,index:Number(target.dataset.index)});toast('Cue stored for deck '+id+'.');break;
    case 'crate':dispatch({type:'library',field:'crate',value:target.dataset.value});break;
    case 'density':dispatch({type:'library',field:'dense',value:!state.library.dense});break;
    case 'load':loadTrack(state.library.target,target.dataset.track);break;
    case 'clear-search':dispatch({type:'library',field:'query',value:''});dispatch({type:'library',field:'crate',value:'all'});break;
    case 'toggle-fx':dispatch({type:'fx',effect:target.dataset.effect,field:'enabled',value:!state.mixer.effects[target.dataset.effect].enabled});break;
    case 'zoom-in':case 'zoom-out':waveZoom.adjust(target.closest('.wavebox'),target.dataset.action==='zoom-in'?1:-1);break;
    case 'pad-mode':ui.padMode[id]=target.dataset.value;update();break;
    case 'pair':dispatch({type:'pair',value:target.dataset.value});break;
    case 'open-settings':openSettings();break;
    case 'close-settings':closeSettings();break;
    case 'open-mixer':$('.mixer-dialog').showModal();break;
    case 'close-mixer':$('.mixer-dialog').close();break;
    case 'open-info':$('.info-dialog').showModal();break;
    case 'close-info':$('.info-dialog').close();break;
  }
});
root.addEventListener('input',event=>{
  const input=event.target;if(!input.matches('[data-action]'))return;
  switch(input.dataset.action) {
    case 'search':dispatch({type:'library',field:'query',value:input.value});break;
    case 'deck-number':dispatch({type:'deck',deck:input.dataset.deck,field:input.dataset.field,value:Number(input.value)});break;
    case 'crossfader':dispatch({type:'mixer',field:'crossfader',value:Number(input.value)});break;
    case 'fx-wet':dispatch({type:'fx',effect:input.dataset.effect,field:'wet',value:Number(input.value)});break;
  }
});
root.addEventListener('change',event=>{
  const input=event.target;
  libraryUI?.handleChange(input);
  if(input.dataset.action==='theme')store.dispatch({type:'theme',value:input.value});
  if(input.dataset.action==='load-target')dispatch({type:'library',field:'target',value:input.value});
});
/** Knobs turn with a vertical drag; the underlying range input keeps keyboard and assistive-technology control. */
root.addEventListener('pointerdown',event=>{
  const knob=event.target.closest('label.knob');if(!knob||event.button!==0)return;
  const input=knob.querySelector('input');if(!input||input.disabled)return;
  event.preventDefault();input.focus({preventScroll:true});
  const startY=event.clientY,start=Number(input.value),min=Number(input.min),max=Number(input.max);
  const move=ev=>{const next=Math.max(min,Math.min(max,Math.round(start+(startY-ev.clientY)*(max-min)/140)));if(Number(input.value)!==next){input.value=next;input.dispatchEvent(new Event('input',{bubbles:true}));}};
  const stop=()=>{removeEventListener('pointermove',move);removeEventListener('pointerup',stop);removeEventListener('pointercancel',stop);};
  addEventListener('pointermove',move);addEventListener('pointerup',stop);addEventListener('pointercancel',stop);
});
// Double-click (or Delete/Backspace on the focused knob) returns gain, an EQ band or the filter to its neutral detent.
function resetKnob(knob) {
  const input=knob?.querySelector('input[data-field]');
  if(!input||input.disabled||!['gain','hi','mid','low','filter'].includes(input.dataset.field))return false;
  input.value=50;dispatch({type:'deck',deck:input.dataset.deck,field:input.dataset.field,value:50});return true;
}
root.addEventListener('dblclick',event=>{if(resetKnob(event.target.closest('.knob')))event.preventDefault();});
root.addEventListener('keydown',event=>{if((event.key==='Delete'||event.key==='Backspace')&&resetKnob(event.target.closest?.('.knob')))event.preventDefault();});
root.addEventListener('contextmenu',event=>{
  const button=event.target.closest('[data-action="hot-cue"]');if(!button)return;event.preventDefault();dispatch({type:'setCue',deck:button.dataset.deck,index:Number(button.dataset.index)});toast('Cue stored at the current UI position.');
});
root.addEventListener('keydown',event=>{
  const row=event.target.closest('tr[data-track-id]');if(!row||event.target!==row)return;
  if(event.altKey&&DECK_IDS.includes(event.key.toUpperCase())){event.preventDefault();loadTrack(event.key.toUpperCase(),row.dataset.trackId);}
  else if(['Enter',' '].includes(event.key)){event.preventDefault();selectedTrack=row.dataset.trackId;libraryUI?.selectRow(row,event);if(!libraryUI)update();}

});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();$('.search')?.focus();}});


editor=new CanvasEditor(root,store,{redraw:mount,say:toast});
new TrackDragLoader(root,{load:loadTrack,say:toast,isNative:()=>Boolean(nativeAudio)});
nativeAudio=nativeBridge?new NativeSession(nativeBridge,store,{redraw:mount,update:updateTransport,say:toast}):null;
gestures=new WaveGesture(root,{store,audio:nativeAudio,zoom:waveZoom,say:toast,painter:{mark:()=>painter.mark(),setScrubbing:(id,on)=>painter.setScrubbing(id,on)}});
painter=new TransportPainter(root,{state:()=>store.get(),preview:id=>gestures.preview(id),zoom:waveZoom,meter:()=>nativeAudio?.status});
if(nativeAudio)nativeAudio.painter=painter;
root.addEventListener('focusin',event=>{if(event.target.matches?.('.wavebox.detail'))painter.flush();});
window.addEventListener('pagehide',()=>gestures.dispose());
if(nativeAudio){libraryUI=new LibraryController(nativeBridge,store,nativeAudio,{redraw:mount,say:toast,root});nativeAudio.libraryUI=libraryUI;}
if(nativeAudio)nativeAudio.warning=nativeWarning;
mount();
{const migrated=store.takeNotice();if(migrated)toast(migrated,9000);}
if(nativeBridge?.unlock){for(const type of ['pointerdown','keydown','touchend'])document.addEventListener(type,()=>nativeBridge.unlock(),{capture:true,passive:true});}
if(nativeBridge?.haltAll)addEventListener('pagehide',()=>nativeBridge.haltAll());
await nativeAudio?.initialize();
