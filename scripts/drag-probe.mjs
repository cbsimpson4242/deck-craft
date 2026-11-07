// In-page helper for the Chromium regression suites: drives the real drag handlers with a real
// DataTransfer and returns observable state. It carries no audio, path or file data.
export const DRAG_TYPE='application/x-deckcraft-track';
export const DRAG_PROBE=`(()=>{
 const TYPE=${JSON.stringify(DRAG_TYPE)};
 let dt=null,row=null;
 const visible=(selector,index=0)=>{const element=[...document.querySelectorAll(selector)].filter(x=>x.getClientRects().length)[index];if(!element)throw Error('No visible '+selector+' #'+index);return element;};
 const state=()=>({hover:[...document.querySelectorAll('.drop-target')].map(e=>e.dataset.dropDeck),dragging:document.querySelectorAll('tr.dragging').length});
 window.__dragProbe={
  start(trackId){dt=new DataTransfer();row=document.querySelector('tr[data-track-id="'+trackId+'"]');const event=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt});row.dispatchEvent(event);return {prevented:event.defaultPrevented,payload:[...dt.types].map(type=>[type,dt.getData(type)]),...state()};},
  forge(type,data){dt=new DataTransfer();row=null;dt.setData(type,data);},
  set(type,data){dt.setData(type,data);},
  fire(type,selector,index=0,related=null){const target=selector==='@row'?row:visible(selector,index);const event=new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt,relatedTarget:related?visible(related):null});target.dispatchEvent(event);return {prevented:event.defaultPrevented,...state()};},
  count(selector){return [...document.querySelectorAll(selector)].filter(x=>x.getClientRects().length).length;},
  state
 };
 return true;
})()`;
