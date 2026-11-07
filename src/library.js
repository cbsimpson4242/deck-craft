import { allTracks, libraryCollections, replaceLocalLibrary, registerLocalTrack, DECK_IDS, browserBackend } from './catalog.js';
import { escapeHTML, icon, timeLabel, sleeve } from './components.js';

// A table without filter controls must never inherit an inaccessible saved filter.
// This is a presentation projection, not a session/collection migration.
export function orderedLibraryTracks(state, { unfiltered = false } = {}) {
  if(unfiltered)return allTracks().filter(t=>t.local).sort((a,b)=>a.title.localeCompare(b.title));
  const group=libraryCollections().find(c=>c.id===state.library.crate);
  const order=new Map((group?.trackIds||[]).map((id,i)=>[id,i]));
  const query=state.library.query.toLowerCase();
  const tracks=allTracks().filter(t=>(state.library.crate==='demo'?!t.local:t.local)&&(!group||order.has(t.id))&&[t.title,t.artist,t.genre].join(' ').toLowerCase().includes(query));
  return tracks.sort((a,b)=>group?.kind==='playlist'&&state.library.sort==='order' ? order.get(a.id)-order.get(b.id) : state.library.sort==='duration' ? a.duration-b.duration||a.title.localeCompare(b.title) : a.title.localeCompare(b.title));
}
export function nativeLibrary(state) {
  const rows=allTracks().map(t=>`<tr data-track-id="${t.id}" tabindex="0" draggable="${t.local?'true':'false'}" aria-selected="false"${t.local?' title="Drag onto a deck or waveform to load it"':''}><td class="library-artwork">${sleeve(t,'thumb')}</td><td class="name-cell"><div><b>${escapeHTML(t.title)}</b><span>${t.local?(t.analysisVersion?(t.bpm?'Local audio · beat grid detected':'Local audio · BPM unavailable'):(browserBackend()?'Local audio · analysis unavailable':'Local audio · analysis pending'))+(t.persisted===false?' · this session only — select again after reload':''):'Synthetic demo · no audio'}</span></div></td><td class="bpm-cell">${t.local&&t.bpm?t.bpm.toFixed(2):'—'}</td><td class="time-cell">${timeLabel(t.duration)}</td><td class="order-cell"><span class="playlist-order"><button data-action="library-move" data-track="${t.id}" data-direction="-1" aria-label="Move ${escapeHTML(t.title)} up">↑</button><button data-action="library-move" data-track="${t.id}" data-direction="1" aria-label="Move ${escapeHTML(t.title)} down">↓</button></span></td></tr>`).join('');
  return `<section class="library local-library ${state.library.dense?'tight-rows':''}"><div class="library-main">
    <div class="table-wrap" title="Select a row and press Alt+A/B/C/D, or drag it onto a deck. Ctrl/⌘-click or Space toggles selection. Loaded tracks stay paused."><table><thead><tr><th>ART</th><th>TRACK</th><th>BPM</th><th class="time-cell">TIME</th><th class="order-heading">ORDER</th></tr></thead><tbody>${rows}</tbody></table><div class="empty" hidden>No local tracks in the library.</div></div>
    <div class="library-feedback" role="status" aria-live="polite"></div>
    <dialog class="collection-dialog"><h2></h2><p></p><label>Name<input class="collection-name" maxlength="80" aria-label="Collection name"></label><div><button data-action="library-save">Save</button><button data-action="library-cancel">Cancel</button></div></dialog>
  </div></section>`;
}

export class LibraryController {
  constructor(bridge,store,native,{redraw,say,root}) {
    Object.assign(this,{bridge,store,native,redraw,say,root});
    this.selected=new Set();this.destination='';this.busy=false;this.message='';
  }
  progress(event) {
    this.message=`Importing ${event.completed} / ${event.total} · ${event.added} added · ${event.failed} failed`;
    this.paint();
  }
  paint() {
    const state=this.store.get(),group=libraryCollections().find(c=>c.id===state.library.crate);
    for(const panel of this.root.querySelectorAll('.local-library:not(.design-preview .local-library)')) {
    const q=s=>panel.querySelector(s),qa=s=>[...panel.querySelectorAll(s)];
    const picker=q('[data-action="library-view"]');
    const visible=orderedLibraryTracks(state,{unfiltered:!picker}),ids=new Set(visible.filter(t=>t.local).map(t=>t.id));
    const set=(selector,property,value)=>{const el=q(selector);if(el)el[property]=value;};
    set('[data-action="library-view"]','value',group?.id||(state.library.crate==='demo'?'demo':'all'));
    if(!libraryCollections().some(c=>c.id===this.destination))this.destination='';
    set('[data-action="library-destination"]','value',this.destination);
    set('.crate-name','textContent',group?.name||(state.library.crate==='demo'?'Demo fixtures':'All local tracks'));
    set('[data-action="library-sort"]','value',state.library.sort);
    set('[data-action="library-sort"] option[value="order"]','disabled',group?.kind!=='playlist');
    for(const action of ['library-rename','library-delete'])set(`[data-action="${action}"]`,'disabled',this.busy||!group);
    for(const el of qa('[data-action="library-import"],[data-action="library-new"]'))el.disabled=this.busy;
    set('[data-action="library-add"]','disabled',this.busy||!this.selected.size||!libraryCollections().length);
    set('[data-action="library-remove"]','disabled',this.busy||!this.selected.size||!group);
    set('[data-action="library-forget"]','disabled',this.busy||!this.selected.size);
    set('.library-selected-count','textContent',`${this.selected.size} selected`);
    set('.library-feedback','textContent',this.message);
    set('[data-action="library-select-visible"]','disabled',this.busy||!ids.size);
    set('.order-heading','hidden',!picker||group?.kind!=='playlist');
    for(const row of qa('tr[data-track-id]')) {
      row.setAttribute('aria-selected',String(this.selected.has(row.dataset.trackId)));row.classList.toggle('selected',this.selected.has(row.dataset.trackId));
      const order=row.querySelector('.order-cell');if(order)order.hidden=!picker||group?.kind!=='playlist';
      const index=group?.trackIds.indexOf(row.dataset.trackId)??-1;
      for(const button of row.querySelectorAll('[data-action="library-move"]'))button.disabled=this.busy||index<0||(button.dataset.direction==='-1'?index===0:index===group.trackIds.length-1);
    }
    }
    for(const el of this.root.querySelectorAll('.settings-native [data-action="library-import"],.settings-native [data-action="library-analyze"]'))el.disabled=this.busy;
  }
  selectRow(row,event={}) {
    const id=row.dataset.trackId;if(!id.startsWith('local-'))return;if(!this.selected.has(id)&&this.selected.size>=1000)return;
    if(event.ctrlKey||event.metaKey||event.key===' '){if(this.selected.has(id))this.selected.delete(id);else this.selected.add(id);}
    else {this.selected.clear();this.selected.add(id);}
    this.lastSelected=id;this.paint();
  }
  async analyze() {
    if(this.busy)return;this.busy=true;this.paint();
    const ids=this.selected.size?[...this.selected]:orderedLibraryTracks(this.store.get()).filter(t=>t.local).map(t=>t.id);
    let failed=0;
    try{for(let i=0;i<ids.length;i++){
      this.message=`Analyzing ${i+1} / ${ids.length}…`;this.paint();
      try{const result=await this.native.call({type:'analyze',trackId:ids[i]});registerLocalTrack(result.track);}catch{failed++;}
    }this.message=`Analysis finished: ${ids.length-failed} processed · ${failed} failed. A blank BPM means no reliable constant beat grid was detected.`;
    }finally{this.busy=false;this.redraw();}
  }
  async run(request) {
    if(this.busy)return;
    this.busy=true;this.paint();
    try {
      const selectedDeckTracks=DECK_IDS.map(id=>this.store.get().decks[id].trackId);
      if(request.type==='forget'&&request.trackIds.some(id=>selectedDeckTracks.includes(id)))throw Error('A selected track is still assigned to a deck. Load a different track before removing it from the library.');
      const result=await this.bridge.command(request);
      if(!result.ok)throw Error(result.error==='track_in_use'?'A selected track is loaded in a deck. Load a different track before removing it from the library.':result.error==='library_save_failed'?'Changes could not be saved. The previous collection is unchanged.':String(result.error).replaceAll('_',' '));
      if(result.cancelled){this.message='Selection cancelled — nothing was added.';return;}
      if(request.type==='import') {
        const s=result.summary;
        this.message=`${s.added} added · ${s.existing} already in library · ${s.failed} failed · ${s.skipped} skipped${s.sessionOnly?` · ${s.sessionOnly} kept for this session only (select again after reload)`:''}${s.truncated?' · Batch limit reached; import smaller folders to continue':''}.${s.errors.length?' '+s.errors.map(e=>e.name+': '+e.error.replaceAll('_',' ')).join('; '):''}`;
      } else this.message='Library saved. Original music files are untouched.';
      if(Object.hasOwn(result,'warning'))this.native.warning=result.warning;
      if(result.tracks)replaceLocalLibrary(result.tracks,result.collections||[],DECK_IDS.map(id=>this.store.get().decks[id].trackId));
      const available=new Set(allTracks().map(t=>t.id));this.selected=new Set([...this.selected].filter(id=>available.has(id)));
      if(request.type==='collection-create') {
        this.store.dispatch({type:'library',field:'crate',value:result.collection.id});
        this.store.dispatch({type:'library',field:'sort',value:result.collection.kind==='playlist'?'order':'title'});
      }
      if(request.type==='collection-delete'||request.type==='import')this.store.dispatch({type:'library',field:'crate',value:'all'});
      if(request.type==='collection-move')this.store.dispatch({type:'library',field:'sort',value:'order'});
    } catch(error) {this.message=error.message;this.say(this.message);}
    finally {this.busy=false;this.redraw();}
  }
  handleClick(target) {
    const action=target.dataset.action;
    if(action==='library-analyze'){this.analyze();return true;}
    if(action==='library-select-visible'){for(const t of orderedLibraryTracks(this.store.get()).filter(t=>t.local)){if(this.selected.size<1000)this.selected.add(t.id);}this.paint();return true;}
    if(action==='library-clear-selection'){this.selected.clear();this.paint();return true;}
    if(!['library-import','library-new','library-rename','library-delete','library-forget','library-cancel','library-save','library-add','library-remove','library-move'].includes(action))return false;
    if(this.busy)return true;
    const group=libraryCollections().find(c=>c.id===this.store.get().library.crate);
    const dialog=(target.closest('.local-library')||this.root).querySelector('.collection-dialog');
    const ids=[...this.selected].slice(0,1000);
    if(action==='library-import')this.run({type:'import',kind:target.dataset.kind});
    else if(['library-new','library-rename','library-delete','library-forget'].includes(action)) {
      this.dialogAction=action;this.dialogKind=target.dataset.kind;
      dialog.querySelector('h2').textContent=action==='library-new'?`New ${this.dialogKind}`:action==='library-rename'?'Rename collection':action==='library-delete'?'Delete collection?':'Remove selected tracks from library?';
      const name=dialog.querySelector('.collection-name');name.closest('label').hidden=!['library-new','library-rename'].includes(action);name.value=action==='library-rename'?group.name:'';
      dialog.querySelector('p').textContent='Original music files will not be moved or deleted.';
      dialog.showModal();if(!name.closest('label').hidden)name.focus();
    } else if(action==='library-cancel')dialog.close();
    else if(action==='library-save') {
      const name=dialog.querySelector('.collection-name').value.trim();
      let request;
      if(this.dialogAction==='library-new')request={type:'collection-create',kind:this.dialogKind,name};
      if(this.dialogAction==='library-rename')request={type:'collection-rename',id:group.id,name};
      if(this.dialogAction==='library-delete')request={type:'collection-delete',id:group.id};
      if(this.dialogAction==='library-forget')request={type:'forget',trackIds:ids};
      if((request?.type==='collection-create'||request?.type==='collection-rename')&&!name){dialog.querySelector('p').textContent='Enter a name.';return true;}
      dialog.close();if(request)this.run(request);
    } else if(action==='library-add') {
      const id=this.destination;
      if(id&&ids.length)this.run({type:'collection-add',id,trackIds:ids});else {this.message='Choose a destination crate or playlist first.';this.paint();}
    } else if(action==='library-remove'&&group&&ids.length)this.run({type:'collection-remove',id:group.id,trackIds:ids});
    else if(action==='library-move'&&group)this.run({type:'collection-move',id:group.id,trackId:target.dataset.track,direction:Number(target.dataset.direction)});
    return true;
  }
  handleChange(input) {
    if(input.dataset.action==='library-view') {
      this.store.dispatch({type:'library',field:'crate',value:input.value});
      this.store.dispatch({type:'library',field:'sort',value:libraryCollections().find(c=>c.id===input.value)?.kind==='playlist'?'order':'title'});
    } else if(input.dataset.action==='library-sort')this.store.dispatch({type:'library',field:'sort',value:input.value});
    else if(input.dataset.action==='library-destination'){this.destination=input.value;this.paint();}

  }
}
