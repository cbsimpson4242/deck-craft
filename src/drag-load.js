import { DECK_IDS, trackById } from './catalog.js';

/**
 * Drag a library track onto a deck face or a waveform to load it. The drag payload is only the
 * track's opaque ID. A drop runs the same load action as the row's Load button (loaded tracks stay
 * paused); this module never touches the audio engine, a path or HTML, and owns no musical state.
 */
export const TRACK_DRAG_TYPE='application/x-deckcraft-track';
const TRACK_DRAG_ID=/^[a-z0-9-]{1,64}$/;

/** Pure drop decision. `active` is set only by a dragstart from this document's own library rows. */
export function validateTrackDrop({types,data,active,native,find=trackById}) {
  if(!Array.from(types||[]).includes(TRACK_DRAG_TYPE))return {ok:false,reason:'foreign'};
  if(!active||typeof active.trackId!=='string')return {ok:false,reason:'external'};
  if(typeof data!=='string'||data!==active.trackId||!TRACK_DRAG_ID.test(data))return {ok:false,reason:'invalid'};
  const track=find(data);
  if(!track)return {ok:false,reason:'stale',message:'That track is no longer in the library. Nothing was loaded.'};
  if(native&&!track.local)return {ok:false,reason:'demo',message:'Demo fixtures contain no audio. Drag one of your local tracks instead.'};
  return {ok:true,trackId:track.id};
}

export class TrackDragLoader {
  constructor(root,{load,say,isNative}) {
    Object.assign(this,{root,load,say,isNative});
    this.active=null;this.hovered=null;
    root.addEventListener('dragstart',event=>this.start(event));
    root.addEventListener('dragenter',event=>this.over(event));
    root.addEventListener('dragover',event=>this.over(event));
    root.addEventListener('dragleave',event=>this.leave(event));
    root.addEventListener('drop',event=>this.drop(event));
    document.addEventListener('dragend',()=>this.finish());
    // No pointer event is delivered during a drag, so one here means any earlier drag is over
    // (for example, its source row was replaced by a redraw before dragend could reach us).
    document.addEventListener('pointerdown',()=>{if(this.active)this.finish();},true);
  }
  hasType(event) {return Array.from(event.dataTransfer?.types||[]).includes(TRACK_DRAG_TYPE);}
  target(event) {
    const element=event.target instanceof Element?event.target.closest('[data-drop-deck]'):null;
    if(!element||!this.root.contains(element)||element.closest('.design-preview'))return null;
    return DECK_IDS.includes(element.dataset.dropDeck)?element:null;
  }
  valid() {
    return Boolean(this.active)&&validateTrackDrop({types:[TRACK_DRAG_TYPE],data:this.active.trackId,active:this.active,native:this.isNative()}).ok;
  }
  mark(element) {
    if(this.hovered&&this.hovered!==element)this.hovered.classList.remove('drop-target');
    this.hovered=element;
    if(element)element.classList.add('drop-target');
  }
  start(event) {
    const row=event.target instanceof Element?event.target.closest('tr[data-track-id]'):null;
    if(!row)return;
    const track=trackById(row.dataset.trackId);
    if(!event.dataTransfer||!this.root.contains(row)||row.closest('.design-preview')||!track||(this.isNative()&&!track.local)){event.preventDefault();return;}
    event.dataTransfer.setData(TRACK_DRAG_TYPE,track.id);
    event.dataTransfer.effectAllowed='copy';
    this.active={trackId:track.id};
    row.classList.add('dragging');
    // A redraw can replace the row mid-drag; its dragend then never reaches the document, but still reaches the row.
    row.addEventListener('dragend',()=>this.finish(),{once:true});
  }
  over(event) {
    if(!this.hasType(event))return;
    const element=this.valid()?this.target(event):null;
    if(!element){this.mark(null);return;}
    event.preventDefault();event.dataTransfer.dropEffect='copy';
    this.mark(element);
  }
  leave(event) {
    if(this.hovered&&!(event.relatedTarget instanceof Node&&this.hovered.contains(event.relatedTarget)))this.mark(null);
  }
  drop(event) {
    if(!this.hasType(event))return;
    const element=this.target(event),active=this.active,data=event.dataTransfer.getData(TRACK_DRAG_TYPE);
    this.finish();
    if(!element)return;
    const result=validateTrackDrop({types:event.dataTransfer.types,data,active,native:this.isNative()});
    if(result.reason==='external')return;
    event.preventDefault();
    if(result.ok)this.load(element.dataset.dropDeck,result.trackId);
    else if(result.message)this.say(result.message);
  }
  finish() {
    this.mark(null);this.active=null;
    for(const row of this.root.querySelectorAll('tr.dragging'))row.classList.remove('dragging');
  }
}
