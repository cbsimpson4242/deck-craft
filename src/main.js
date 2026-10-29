import { DECK_IDS, LAYOUTS, trackById } from './catalog.js';
import { NativeSession, restoreNativeCatalog } from './native.js';
import { createStore } from './store.js';
import { createViewOptions, renderSession } from './views.js';
import { icon, timeLabel, paintWaveBox } from './components.js';
import { LibraryController, orderedLibraryTracks } from './library.js';
import { CanvasEditor } from './canvas-editor.js';

const root=document.getElementById('app');
const nativeBridge=globalThis.deckCraftNative||null;
const nativeWarning=await restoreNativeCatalog(nativeBridge);
let nativeAudio=null;
let libraryUI=null;
let editor=null;
const store=createStore({getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)});
const options=Object.fromEntries(LAYOUTS.map(layout=>[layout.id,createViewOptions()]));
const $=(selector,parent=root)=>[...parent.querySelectorAll(selector)].find(el=>!el.closest('.design-preview'));
const $$=(selector,parent=root)=>[...parent.querySelectorAll(selector)].filter(el=>!el.closest('.design-preview'));
let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);const target=$('.toast');target.textContent=message;
  toastTimer=setTimeout(()=>{const current=$('.toast');if(current)current.textContent='';},2800);
}
function update() {
  const state=store.get(),ui=options[state.layout],layout=LAYOUTS.find(l=>l.id===state.layout);
  const custom=store.getWorkspace().active;
  document.body.className=(custom?'studio refined canvas-mode':layout.classes)+' engine-off'+(state.mode==='prepare'?' prepare-mode':'')+(!ui.grid?' no-grid':'')+(ui.detail?' wave-detail':'');
  root.dataset.layout=custom?'canvas':state.layout;
  document.title='Deck Craft — '+(custom?'Custom canvas':layout.name);
  $$('.layout-picker').forEach(select=>{select.value=custom?'canvas':state.layout;});
  $$('.mode').forEach(button=>button.classList.toggle('active',button.dataset.value===state.mode));
  const persistenceWarning=[store.getWarning(),nativeAudio?.warning].filter(Boolean).join(' ');
  const warning=$('.persistence-warning');warning.hidden=!persistenceWarning;warning.textContent=persistenceWarning;root.dataset.saved=persistenceWarning?'false':'true';
  for(const id of DECK_IDS) {
    const d=state.decks[id],track=trackById(d.trackId);
    $$(`section.deck[data-deck="${id}"]`).forEach(section=>{
      $$('.remaining',section).forEach(el=>el.textContent='−'+timeLabel(track.duration-d.position,true));
      $$('.elapsed',section).forEach(el=>el.textContent=timeLabel(d.position,true)+(el.closest('.linear-clock')?' / '+timeLabel(track.duration):''));
      section.classList.toggle('active-pair',state.layout==='studio-sync'&&state.pair.includes(id.toLowerCase()));
    });
    $$(`[data-action="toggle-deck"][data-deck="${id}"]`).forEach(button=>{
      const on=d[button.dataset.field];button.setAttribute('aria-pressed',String(on));
      if(button.classList.contains('play')||button.closest('.hidden-deck')) {button.innerHTML=icon(on?'pause':'play');button.setAttribute('aria-label',(on?'Pause':'Play')+' deck '+id+' UI transport; no audio');}
      if(button.classList.contains('loop')) {const length=$('.loop-len',button);if(length)length.textContent=d.loopLength;}
    });
    $$(`[data-action="deck-number"][data-deck="${id}"]`).forEach(input=>{
      const value=d[input.dataset.field];if(Number(input.value)!==value&&(!nativeAudio||document.activeElement!==input))input.value=value;
      const label=input.closest('label');
      if(label?.classList.contains('knob')) {$('.dial i',label).style.transform=`rotate(${(value-50)*2.7}deg)`;input.setAttribute('aria-valuetext',value+' percent');}
      if(label?.classList.contains('pitch')) $('output',label).textContent=(value>=0?'+':'')+value.toFixed(1)+'%';
    });
    $$(`[data-action="hot-cue"][data-deck="${id}"]`).forEach(button=>{
      const index=Number(button.dataset.index),cue=d.cues[index];$('small',button).textContent=timeLabel(cue);button.setAttribute('aria-pressed',String(Math.abs(cue-d.position)<.05));button.classList.toggle('filled',index===0||cue>0);
    });
    $$(`[data-action="loop-length"][data-deck="${id}"]`).forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.value)===d.loopLength)));
    $$(`[data-pitch-readout="${id}"]`).forEach(el=>el.textContent=(d.pitch>=0?'+':'')+d.pitch.toFixed(1)+'%');
    $$(`[data-wave-deck="${id}"]`).forEach(box=>{
      paintWaveBox(box,d.position/track.duration);
      $$('[data-cue-flag]',box).forEach(flag=>{const index=Number(flag.dataset.cueFlag),cue=d.cues[index];flag.style.left=cue/track.duration*100+'%';flag.hidden=!(index===0||cue>0);});
    });
    const hidden=$(`[data-hidden-deck="${id}"]`);
    if(hidden){$('.hidden-track',hidden).textContent=track.title;$('.hidden-state',hidden).textContent=d.playing?'UI transport on':'Paused';hidden.classList.toggle('active',d.playing||d.headphone||d.loopEnabled);}
  }
  $$('[data-action="crossfader"]').forEach(input=>{if(!nativeAudio||document.activeElement!==input)input.value=state.mixer.crossfader;});
  for(const effect of ['echo','space']) {
    $$(`[data-action="toggle-fx"][data-effect="${effect}"]`).forEach(button=>button.setAttribute('aria-pressed',String(state.mixer.effects[effect].enabled)));
    $$(`[data-action="fx-wet"][data-effect="${effect}"]`).forEach(input=>input.value=state.mixer.effects[effect].wet);
  }
  $$('.library').forEach(el=>el.classList.toggle('tight-rows',state.library.dense));
  $$('.view-toggle').forEach(el=>el.setAttribute('aria-pressed',String(state.library.dense)));
  $$('.search').forEach(el=>{if(el.value!==state.library.query)el.value=state.library.query;});
  $$('.load-target').forEach(el=>el.value=state.library.target);
  const query=state.library.query.toLowerCase();
  const localOrder=nativeAudio?orderedLibraryTracks(state):null,localVisible=new Set(localOrder?.map(t=>t.id));
  $$('tr[data-track-id]').forEach(row=>{
    const track=trackById(row.dataset.trackId),matches=nativeAudio?localVisible.has(track.id):(state.library.crate==='all'||track.genre===state.library.crate)&&[track.title,track.artist,track.genre,track.key,track.bpm].join(' ').toLowerCase().includes(query);
    row.hidden=!matches;
    row.classList.toggle('selected',state.decks[state.library.target].trackId===track.id);
    $('.load',row).setAttribute('aria-label','Load '+track.title+' into deck '+state.library.target);
  });
  $$('.library').forEach(el=>{const count=$$('tr[data-track-id]:not([hidden])',el).length;$('.track-count',el).textContent=count+(count===1?' track':' tracks');$('.empty',el).hidden=count!==0;});
  $$('.crate-name').forEach(el=>el.textContent=state.library.crate==='all'?'All tracks':state.library.crate);
  $$('.crate').forEach(button=>button.classList.toggle('active',button.dataset.value===state.library.crate));
  if(localOrder)for(const track of localOrder)for(const row of $$(`tr[data-track-id="${track.id}"]`))row.parentElement.append(row);
  $$('.grid-toggle').forEach(button=>button.setAttribute('aria-pressed',String(ui.grid)));
  $$('.wave-zoom').forEach(button=>button.setAttribute('aria-pressed',String(ui.detail)));
  $$('[data-action="all-cues"]').forEach(button=>button.setAttribute('aria-expanded',String(ui.cuesOpen)));
  $$('[data-all-cues]').forEach(panel=>panel.hidden=state.layout==='signal-wide'&&!ui.cuesOpen);
  $$('[data-action="cue-disclosure"]').forEach(button=>button.setAttribute('aria-expanded',String(ui.openCues[button.dataset.deck])));
  $$('[data-cue-panel]').forEach(panel=>panel.hidden=!ui.openCues[panel.dataset.cuePanel]);
  $$('[data-action="pair"]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.value===state.pair)));
  $$('.wave-group').forEach(group=>group.hidden=group.dataset.group!==state.pair);
  nativeAudio?.paint();
  libraryUI?.paint();
}
function mount() {
  const focusAction=document.activeElement?.dataset?.action;
  editor?.beforeMount();
  root.innerHTML=renderSession(store.get(),options[store.get().layout],store.getWorkspace(),editor?.ui,store.getWorkspaceHistory());update();
  editor?.afterMount();
  if(focusAction==='layout') $('.layout-picker').focus({preventScroll:true});
}
store.subscribe((state,action)=>{if(['layout','load','workspace'].includes(action.type))mount();else update();});
function dispatch(action){if(!nativeAudio?.dispatch(action))store.dispatch(action);}

root.addEventListener('click',event=>{
  const target=event.target.closest('button[data-action]');if(!target||!root.contains(target))return;
  if(libraryUI?.handleClick(target))return;
  const state=store.get(),ui=options[state.layout],id=target.dataset.deck,field=target.dataset.field;
  switch(target.dataset.action) {
    case 'import-audio':nativeAudio?.importAudio(store.get().library.target);break;
    case 'reconnect-audio':nativeAudio?.reconnect();break;
    case 'mode':dispatch({type:'mode',value:target.dataset.value});break;
    case 'toggle-deck':dispatch({type:'deck',deck:id,field,value:!state.decks[id][field]});if(field==='playing'&&!nativeAudio)toast('Transport UI state only — no audio engine is connected.');break;
    case 'cue':dispatch({type:'cue',deck:id});break;
    case 'loop-length':dispatch({type:'deck',deck:id,field:'loopLength',value:Number(target.dataset.value)});break;
    case 'loop-size':dispatch({type:'deck',deck:id,field:'loopLength',value:Math.max(1,Math.min(32,state.decks[id].loopLength*Number(target.dataset.factor)))});break;
    case 'hot-cue':dispatch({type:event.shiftKey?'setCue':'hotCue',deck:id,index:Number(target.dataset.index)});if(event.shiftKey)toast('Cue stored at the current UI position.');break;
    case 'set-cue':dispatch({type:'setCue',deck:id,index:Number(target.dataset.index)});toast('Cue stored for deck '+id+'.');break;
    case 'crate':dispatch({type:'library',field:'crate',value:target.dataset.value});break;
    case 'density':dispatch({type:'library',field:'dense',value:!state.library.dense});break;
    case 'load':dispatch({type:'load',deck:state.library.target,trackId:target.dataset.track});if(!nativeAudio)toast('Demo track loaded into deck '+state.library.target+'. Waveform is synthetic; no audio is loaded.');break;
    case 'clear-search':dispatch({type:'library',field:'query',value:''});dispatch({type:'library',field:'crate',value:'all'});break;
    case 'toggle-fx':dispatch({type:'fx',effect:target.dataset.effect,field:'enabled',value:!state.mixer.effects[target.dataset.effect].enabled});break;
    case 'grid':ui.grid=!ui.grid;update();break;
    case 'detail':ui.detail=!ui.detail;update();break;
    case 'all-cues':ui.cuesOpen=!ui.cuesOpen;update();break;
    case 'cue-disclosure':ui.openCues[id]=!ui.openCues[id];update();break;
    case 'pair':dispatch({type:'pair',value:target.dataset.value});break;
    case 'open-mixer':$('.mixer-dialog').showModal();break;
    case 'close-mixer':$('.mixer-dialog').close();break;
    case 'open-info':$('.info-dialog').showModal();break;
    case 'close-info':$('.info-dialog').close();break;
    case 'show-four':dispatch({type:'mode',value:'perform'});dispatch({type:'pair',value:'cd'});dispatch({type:'layout',value:'studio-sync'});$('section[data-deck="C"]')?.scrollIntoView({block:'nearest'});break;
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
  if(input.dataset.action==='layout'){
    const value=input.value;
    if(value==='canvas')store.dispatchWorkspace({type:'active',value:true});
    else {if(store.getWorkspace().active)store.dispatchWorkspace({type:'active',value:false});dispatch({type:'layout',value});}
  }
  if(input.dataset.action==='load-target')dispatch({type:'library',field:'target',value:input.value});
});
root.addEventListener('contextmenu',event=>{
  const button=event.target.closest('[data-action="hot-cue"]');if(!button)return;event.preventDefault();dispatch({type:'setCue',deck:button.dataset.deck,index:Number(button.dataset.index)});toast('Cue stored at the current UI position.');
});
root.addEventListener('keydown',event=>{
  const row=event.target.closest('tr[data-track-id]');if(row&&event.target===row&&event.key==='Enter'){$('.load',row).click();}
});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();$('.search')?.focus();}});
editor=new CanvasEditor(root,store,{redraw:mount,say:toast});
nativeAudio=nativeBridge?new NativeSession(nativeBridge,store,{redraw:mount,say:toast}):null;
if(nativeAudio){libraryUI=new LibraryController(nativeBridge,store,nativeAudio,{redraw:mount,say:toast,root});nativeAudio.libraryUI=libraryUI;}
if(nativeAudio)nativeAudio.warning=nativeWarning;
mount();
await nativeAudio?.initialize();
