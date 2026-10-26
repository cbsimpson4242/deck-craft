import { allTracks, libraryCollections, replaceLocalLibrary, DECK_IDS } from './catalog.js';
import { escapeHTML, icon, timeLabel } from './components.js';

export function orderedLibraryTracks(state) {
  const group=libraryCollections().find(c=>c.id===state.library.crate);
  const order=new Map((group?.trackIds||[]).map((id,i)=>[id,i]));
  const query=state.library.query.toLowerCase();
  const tracks=allTracks().filter(t=>(state.library.crate==='demo'?!t.local:t.local)&&(!group||order.has(t.id))&&[t.title,t.artist,t.genre].join(' ').toLowerCase().includes(query));
  return tracks.sort((a,b)=>group?.kind==='playlist'&&state.library.sort==='order' ? order.get(a.id)-order.get(b.id) : state.library.sort==='duration' ? a.duration-b.duration||a.title.localeCompare(b.title) : a.title.localeCompare(b.title));
}
export function nativeLibrary(state) {
  const groups=libraryCollections(),group=groups.find(c=>c.id===state.library.crate);
  const rows=allTracks().map(t=>`<tr data-track-id="${t.id}" tabindex="0"><td class="library-check">${t.local?`<input type="checkbox" data-action="library-select" data-track="${t.id}" aria-label="Select ${escapeHTML(t.title)}">`:''}</td><td class="name-cell"><div><b>${escapeHTML(t.title)}</b><span>${t.local?'Local audio · analysis pending':'Synthetic demo · no audio'}</span></div></td><td class="bpm-cell">—</td><td class="time-cell">${timeLabel(t.duration)}</td><td class="load-cell"><button class="load" data-action="load" data-track="${t.id}" ${t.local?'':'disabled'} aria-label="Load ${escapeHTML(t.title)} into selected deck">${icon('arrow')}</button><span class="playlist-order"><button data-action="library-move" data-track="${t.id}" data-direction="-1" aria-label="Move ${escapeHTML(t.title)} up">↑</button><button data-action="library-move" data-track="${t.id}" data-direction="1" aria-label="Move ${escapeHTML(t.title)} down">↓</button></span></td></tr>`).join('');
  return `<section class="library local-library ${state.library.dense?'tight-rows':''}"><div class="library-main">
    <div class="library-toolbar"><div class="library-title">Your music <span class="divider">/</span><strong class="crate-name">${escapeHTML(group?.name||'All tracks')}</strong><span class="track-count"></span></div><label class="searchbox">${icon('search')}<input class="search" data-action="search" placeholder="Search your music" value="${escapeHTML(state.library.query)}" aria-label="Search collection"></label><button class="icon-btn view-toggle" data-action="density" aria-label="Toggle compact rows">${icon('list')}</button></div>
    <div class="library-imports"><button data-action="library-import" data-kind="files">${icon('music')}Add files</button><button data-action="library-import" data-kind="folder">${icon('folder')}Add folder</button><button data-action="library-new" data-kind="crate">+ New crate</button><button data-action="library-new" data-kind="playlist">+ New playlist</button></div>
    <div class="library-navigation"><label>Collection<select data-action="library-view" aria-label="Music collection"><option value="all">All local tracks</option>${groups.map(c=>`<option value="${c.id}" ${group?.id===c.id?'selected':''}>${c.kind==='playlist'?'Playlist':'Crate'} · ${escapeHTML(c.name)} (${c.trackIds.length})</option>`).join('')}<option value="demo" ${state.library.crate==='demo'?'selected':''}>Demo fixtures · no audio</option></select></label><label>Sort<select data-action="library-sort" aria-label="Sort tracks"><option value="title">Title</option><option value="duration">Duration</option><option value="order">Playlist order</option></select></label><button data-action="library-rename">Rename</button><button data-action="library-delete">Delete collection</button></div>
    <div class="library-selection"><label><input type="checkbox" data-action="library-select-all" aria-label="Select visible tracks">Select visible</label><span class="library-selected-count">0 selected</span><label>Add to<select data-action="library-destination" aria-label="Add selected tracks to collection"><option value="">Choose crate / playlist</option>${groups.map(c=>`<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('')}</select></label><button data-action="library-add">Add selected</button><button data-action="library-remove">Remove from collection</button><button data-action="library-forget">Remove from library</button></div>
    <label class="load-choice">LOAD INTO <select class="load-target" data-action="load-target" aria-label="Load into deck">${DECK_IDS.map(id=>`<option value="${id}" ${id===state.library.target?'selected':''}>Deck ${id}</option>`).join('')}</select><span>Load stays paused · files remain in their original location</span></label>
    <div class="library-feedback" role="status" aria-live="polite"></div>
    <div class="table-wrap"><table><thead><tr><th>Select</th><th>TRACK</th><th>BPM</th><th class="time-cell">TIME</th><th>LOAD / ORDER</th></tr></thead><tbody>${rows}</tbody></table><div class="empty" hidden>No tracks here. Add files or a folder, or add selected tracks to this collection. <button data-action="clear-search">Show all tracks</button></div></div>
    <dialog class="collection-dialog"><h2></h2><p></p><label>Name<input class="collection-name" maxlength="80" aria-label="Collection name"></label><div><button data-action="library-save">Save</button><button data-action="library-cancel">Cancel</button></div></dialog>
  </div></section>`;
}

export class LibraryController {
  constructor(bridge,store,native,{redraw,say,root}) {
    Object.assign(this,{bridge,store,native,redraw,say,root});
    this.selected=new Set();this.destination='';this.busy=false;this.message='Add your music to the library, then load a deck and press Play.';
  }
  progress(event) {
    this.message=`Importing ${event.completed} / ${event.total} · ${event.added} added · ${event.failed} failed`;
    this.paint();
  }
  paint() {
    const state=this.store.get(),group=libraryCollections().find(c=>c.id===state.library.crate);
    for(const panel of this.root.querySelectorAll('.local-library:not(.design-preview .local-library)')) {
    const q=s=>panel.querySelector(s),qa=s=>[...panel.querySelectorAll(s)];
    const visible=orderedLibraryTracks(state),ids=new Set(visible.filter(t=>t.local).map(t=>t.id));
    const picker=q('[data-action="library-view"]');if(!picker)continue;
    picker.value=group?.id||(state.library.crate==='demo'?'demo':'all');
    if(!libraryCollections().some(c=>c.id===this.destination))this.destination='';
    q('[data-action="library-destination"]').value=this.destination;
    q('.crate-name').textContent=group?.name||(state.library.crate==='demo'?'Demo fixtures':'All local tracks');
    q('[data-action="library-sort"]').value=state.library.sort;
    q('[data-action="library-sort"] option[value="order"]').disabled=group?.kind!=='playlist';
    for(const action of ['library-rename','library-delete'])q(`[data-action="${action}"]`).disabled=this.busy||!group;
    for(const el of qa('[data-action="library-import"],[data-action="library-new"]'))el.disabled=this.busy;
    q('[data-action="library-add"]').disabled=this.busy||!this.selected.size||!libraryCollections().length;
    q('[data-action="library-remove"]').disabled=this.busy||!this.selected.size||!group;
    q('[data-action="library-forget"]').disabled=this.busy||!this.selected.size;
    q('.library-selected-count').textContent=`${this.selected.size} selected`;
    q('.library-feedback').textContent=this.message;
    for(const el of qa('[data-action="library-select"]'))el.checked=this.selected.has(el.dataset.track);
    const selectAll=q('[data-action="library-select-all"]'),n=[...ids].filter(id=>this.selected.has(id)).length;
    selectAll.checked=ids.size>0&&n===ids.size;selectAll.indeterminate=n>0&&n<ids.size;selectAll.disabled=this.busy||!ids.size;
    for(const row of qa('tr[data-track-id]')) {
      row.querySelector('.playlist-order').hidden=group?.kind!=='playlist';
      const index=group?.trackIds.indexOf(row.dataset.trackId)??-1;
      for(const button of row.querySelectorAll('[data-action="library-move"]'))button.disabled=this.busy||index<0||(button.dataset.direction==='-1'?index===0:index===group.trackIds.length-1);
    }
    }
  }
  async run(request) {
    if(this.busy)return;
    this.busy=true;this.paint();
    try {
      const selectedDeckTracks=DECK_IDS.map(id=>this.store.get().decks[id].trackId);
      if(request.type==='forget'&&request.trackIds.some(id=>selectedDeckTracks.includes(id)))throw Error('A selected track is still assigned to a deck. Load a different track before removing it from the library.');
      const result=await this.bridge.command(request);
      if(!result.ok)throw Error(result.error==='track_in_use'?'A selected track is loaded in a deck. Load a different track before removing it from the library.':result.error==='library_save_failed'?'Changes could not be saved. The previous collection is unchanged.':String(result.error).replaceAll('_',' '));
      if(result.cancelled)return;
      if(request.type==='import') {
        const s=result.summary;
        this.message=`${s.added} added · ${s.existing} already in library · ${s.failed} failed · ${s.skipped} skipped${s.truncated?' · Batch limit reached; import smaller folders to continue':''}.${s.errors.length?' '+s.errors.map(e=>e.name+': '+e.error.replaceAll('_',' ')).join('; '):''}`;
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
    else if(input.dataset.action==='library-select') {if(input.checked&&this.selected.size<1000)this.selected.add(input.dataset.track);else this.selected.delete(input.dataset.track);this.paint();}
    else if(input.dataset.action==='library-select-all') {
      for(const track of orderedLibraryTracks(this.store.get()).filter(t=>t.local)) {if(input.checked&&this.selected.size<1000)this.selected.add(track.id);else if(!input.checked)this.selected.delete(track.id);}
      this.paint();
    }
  }
}
