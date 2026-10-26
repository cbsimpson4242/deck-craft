import { createSession } from './session.js';
import { createComponent, parseDesign, creatorKit, DESIGN_LIMIT } from './workspace.js';
import { renderCanvasContent, canvasStyle } from './canvas-view.js';
import { escapeHTML } from './components.js';

export const CANVAS_UNAVAILABLE='[data-field="sync"],[data-field="headphone"],[data-field="loopEnabled"],[data-field="pitch"],[data-action="loop-size"],[data-action="toggle-fx"],[data-action="fx-wet"],[data-field="gain"],[data-field="hi"],[data-field="mid"],[data-field="low"],[data-field="filter"]';
export function renderDesignPreview(design,variant='paused') {
 const fixture=createSession();
 for(const d of Object.values(fixture.decks)){d.playing=variant==='playing';if(variant==='empty'){d.position=0;d.cues=[0,0,0,0];}}
 const designs=design.format==='deckcraft.workspace'?design.items.map(item=>item.design):[design];
 return `<p class="preview-caption">SYNTHETIC ${escapeHTML(variant.toUpperCase())} FIXTURE · NOT AUDIO</p>`+designs.map(d=>`<div class="preview-component canvas-widget" data-kind="${d.kind}" data-density="${d.style.density}" data-waveform="${d.parts.waveform}" data-cues="${d.parts.cues}" data-artwork="${d.parts.artwork}" style="${canvasStyle(d)}"><h3>${escapeHTML(d.name)}</h3>${variant==='empty'?'<p>No track loaded · synthetic empty state</p>':variant==='unavailable'?'<p>Engine unavailable · controls disabled</p>':renderCanvasContent(d,fixture,{preview:true}).replace(/ data-[a-z0-9-]+="[^"]*"/g,'')}</div>`).join('');
}
export function downloadDesign(name,value) {
 const link=document.createElement('a');link.download=name;link.href='data:application/json;charset=utf-8,'+encodeURIComponent(JSON.stringify(value,null,2));document.body.append(link);link.click();link.remove();
}
/** Only layout data reaches the store. Audio continues through the existing semantic handlers. */
export class CanvasEditor {
 constructor(root,store,{redraw,say}) {
  this.root=root;this.store=store;this.redraw=redraw;this.say=say;
  this.ui={editing:true,selected:null,deck:'A'};this.creatorOpen=false;this.draft='';this.reviewed=null;this.naming=null;
  root.addEventListener('click',event=>this.click(event));
  root.addEventListener('change',event=>this.change(event));
  root.addEventListener('input',event=>{if(event.target.matches('.design-json')){this.draft=event.target.value;this.reviewed=null;root.querySelector('[data-editor="apply-design"]').disabled=true;root.querySelector('.design-result').textContent='Design changed. Validate again before applying.';}});
  root.addEventListener('pointerdown',event=>this.pointerDown(event));
  document.addEventListener('pointermove',event=>this.pointerMove(event));
  document.addEventListener('pointerup',event=>this.pointerUp(event));
  document.addEventListener('pointercancel',()=>{if(this.drag){this.drag=null;this.redraw();}});
  root.addEventListener('dragstart',event=>{const button=event.target.closest('[draggable][data-kind]');if(!button)return;if(!this.ui.editing){event.preventDefault();return;}event.dataTransfer.setData('application/x-deckcraft-kind',button.dataset.kind);event.dataTransfer.effectAllowed='copy';});
  root.addEventListener('dragover',event=>{if(this.ui.editing&&event.target.closest('.canvas-stage')&&event.dataTransfer.types.includes('application/x-deckcraft-kind'))event.preventDefault();});
  root.addEventListener('drop',event=>{const stage=event.target.closest('.canvas-stage');if(!stage||!this.ui.editing)return;const kind=event.dataTransfer.getData('application/x-deckcraft-kind');if(!kind)return;event.preventDefault();const rect=stage.getBoundingClientRect();this.add(kind,{x:this.coordinate(event.clientX-rect.left,2400),y:this.coordinate(event.clientY-rect.top,4800)});});
  document.addEventListener('keydown',event=>{
   if(!store.getWorkspace().active||!this.ui.editing||event.target.closest('input,textarea,select,dialog'))return;
   if((event.ctrlKey||event.metaKey)&&['z','y'].includes(event.key.toLowerCase())){event.preventDefault();this.act({type:event.key.toLowerCase()==='y'||event.shiftKey?'redo':'undo'});}
   if(event.key==='Delete'&&this.ui.selected){event.preventDefault();this.act({type:'remove',id:this.ui.selected});}
   const grip=event.target.closest('.widget-grip');
   if(grip&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();const item=this.item(grip.dataset.id),step=event.shiftKey?100:20;this.act({type:'item',id:item.id,patch:{x:Math.max(0,Math.min(2400,item.x+(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0))),y:Math.max(0,Math.min(4800,item.y+(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0)))}});this.root.querySelector(`[data-id="${item.id}"]`)?.focus();}
   if(grip&&['Enter',' '].includes(event.key)){event.preventDefault();this.ui.selected=grip.dataset.id;this.redraw();}
  });
 }
 item(id=this.ui.selected) {return this.store.getWorkspace().snapshot.items.find(item=>item.id===id);}
 act(action) {try{this.store.dispatchWorkspace(action);return true;}catch(error){this.say(error.message);return false;}}
 beforeMount() {
  const viewport=this.root.querySelector('.canvas-viewport');if(viewport)this.scroll={left:viewport.scrollLeft,top:viewport.scrollTop};
  const draft=this.root.querySelector('.design-json');if(draft)this.draft=draft.value;
 }
 afterMount() {
  if(this.store.getWorkspace().active){
   for(const control of this.root.querySelectorAll('.canvas-shell '+CANVAS_UNAVAILABLE.split(',').join(',.canvas-shell '))){control.disabled=true;control.title='Not implemented in the native engine';}
   if(!this.ui.editing)for(const el of this.root.querySelectorAll('.canvas-tools [data-editor]:not([data-editor="edit"]):not([data-editor="perform"]),.canvas-tools input'))el.disabled=true;
   const viewport=this.root.querySelector('.canvas-viewport');if(this.scroll&&viewport){viewport.scrollLeft=this.scroll.left;viewport.scrollTop=this.scroll.top;}
  }
  const dialog=this.root.querySelector('.creator-dialog');
  if(dialog){dialog.addEventListener('cancel',()=>{this.creatorOpen=false;});dialog.querySelector('.design-json').value=this.draft;if(this.creatorOpen){dialog.showModal();if(this.reviewed)this.preview();}}
  const naming=this.root.querySelector('.canvas-name-dialog');if(naming){naming.addEventListener('cancel',()=>{this.naming=null;});if(this.naming){naming.querySelector('.canvas-name-title').textContent=this.naming.title;naming.querySelector('input').value=this.naming.value;naming.showModal();}}
 }
 add(kind,position) {
  if(!this.act({type:'add',kind,deck:this.ui.deck,position}))return;
  const item=this.store.getWorkspace().snapshot.items.at(-1);this.ui.selected=item.id;
  this.redraw();
 }
 name(type,title,value) {this.naming={type,title,value,id:this.ui.selected};this.redraw();}
 click(event) {
  const button=event.target.closest('[data-editor]');if(!button||!this.root.contains(button))return;
  const action=button.dataset.editor,index=Number(button.dataset.index);
  if(action==='open-canvas'){this.act({type:'active',value:true});return;}
  if(action==='edit'||action==='perform'){this.ui.editing=action==='edit';this.redraw();return;}
  if(!this.ui.editing)return;
  if(action==='select'){if(this.suppressClick){this.suppressClick=false;return;}this.ui.selected=button.dataset.id;this.redraw();return;}
  if(action==='add'){this.add(button.dataset.kind);return;}
  if(action==='add-template'){if(this.act({type:action,index,deck:this.ui.deck})){this.ui.selected=this.store.getWorkspace().snapshot.items.at(-1).id;this.redraw();}return;}
  if(['delete-template','delete-preset','load-preset'].includes(action)){this.act({type:action,index});return;}
  if(['undo','redo','clear'].includes(action)){if(action==='clear'&&this.store.getWorkspace().snapshot.items.length&&!confirm('Start an empty canvas? Your audio and saved components stay intact. Undo restores this arrangement.'))return;this.act({type:action});return;}
  if(action==='remove'){this.act({type:'remove',id:this.ui.selected});return;}
  if(action==='duplicate'){const item=this.item();if(item){this.act({type:'import',text:JSON.stringify(item.design)});this.ui.selected=this.store.getWorkspace().snapshot.items.at(-1).id;this.redraw();}return;}
  if(action==='save-template'){this.name(action,'Save reusable component',this.item()?.design.name||'My component');return;}
  if(action==='save-preset'){this.name(action,'Save workspace preset',this.store.getWorkspace().snapshot.name);return;}
  if(action==='confirm-name'){
   const naming=this.naming,value=this.root.querySelector('.canvas-name-input').value.trim();if(!value){this.say('Enter a name.');return;}
   this.naming=null;this.act({type:naming.type,id:naming.id,name:value});this.redraw();return;
  }
  if(action==='cancel-name'){this.naming=null;this.redraw();return;}
  if(action==='export-component'){if(this.item())downloadDesign('deckcraft-component.json',this.item().design);return;}
  if(action==='export-workspace'){downloadDesign('deckcraft-workspace.json',this.store.getWorkspace().snapshot);return;}
  if(action==='creator'){this.creatorOpen=true;this.reviewed=null;this.draft=JSON.stringify(this.item()?.design||createComponent('deck',this.ui.deck),null,2);this.redraw();return;}
  if(action==='close-creator'){this.creatorOpen=false;this.root.querySelector('.creator-dialog').close();return;}
  if(action==='download-kit'){downloadDesign('deckcraft-creator-kit.json',creatorKit(this.item()?.design||createComponent('deck',this.ui.deck)));return;}
  if(action==='download-component'){downloadDesign('deckcraft-component.json',this.item()?.design||createComponent('deck',this.ui.deck));return;}
  if(action==='validate'){this.validate();return;}
  if(action==='apply-design'){
   if(!this.reviewed||this.draft!==this.reviewedText)return;
   if(this.reviewed.format==='deckcraft.workspace'&&!confirm('Replace the current canvas with this reviewed workspace? Audio is unchanged. Undo restores the previous canvas.'))return;
   const text=this.draft;this.creatorOpen=false;if(this.act({type:'import',text})){this.ui.selected=this.store.getWorkspace().snapshot.items.at(-1)?.id;this.say('Design applied. Audio session unchanged.');this.redraw();}else{this.creatorOpen=true;this.redraw();}
  }
 }
 async change(event) {
  const input=event.target;
  if(input.matches('.new-component-deck')){this.ui.deck=input.value;return;}
  if(input.matches('.preview-state')){if(this.reviewed)this.preview();return;}
  if(!this.ui.editing)return;
  if(input.matches('.starter-picker')){if(input.value&&(!this.store.getWorkspace().snapshot.items.length||confirm('Replace this canvas with a starter? Audio is unchanged. Undo restores this arrangement.')))this.act({type:'starter',value:input.value});return;}
  if(input.matches('.design-file')){
   const file=input.files[0];if(!file)return;const dialog=this.root.querySelector('.creator-dialog');
   if(file.size>DESIGN_LIMIT){dialog.querySelector('.design-result').textContent='Design exceeds 256 KiB.';this.reviewed=null;dialog.querySelector('[data-editor="apply-design"]').disabled=true;return;}
   try {const text=await file.text();if(!dialog.isConnected||!this.creatorOpen)return;this.draft=text;dialog.querySelector('.design-json').value=text;this.validate();}catch{dialog.querySelector('.design-result').textContent='Could not read this design file.';}return;
  }
  const field=input.dataset.editorField;if(!field)return;
  if(field==='snap'){this.act({type:'snap',value:input.checked});return;}
  const id=this.ui.selected;
  if(['x','y','width','height'].includes(field))this.act({type:'item',id,patch:{[field]:Number(input.value)}});
  else if(['waveform','cues','artwork'].includes(field))this.act({type:'parts',id,patch:{[field]:input.checked}});
  else if(['name','deck'].includes(field))this.act({type:'design',id,patch:{[field]:input.value}});
  else this.act({type:'style',id,patch:{[field]:['radius','fontScale'].includes(field)?Number(input.value):input.value}});
 }
 validate() {
  const dialog=this.root.querySelector('.creator-dialog');this.draft=dialog.querySelector('.design-json').value;
  try{this.reviewed=parseDesign(this.draft);this.reviewedText=this.draft;this.preview();}
  catch(error){this.reviewed=null;dialog.querySelector('.design-result').textContent=error.message;dialog.querySelector('.design-preview').replaceChildren();dialog.querySelector('[data-editor="apply-design"]').disabled=true;}
 }
 preview() {
  const dialog=this.root.querySelector('.creator-dialog');dialog.querySelector('.design-preview').innerHTML=renderDesignPreview(this.reviewed,dialog.querySelector('.preview-state').value);
  for(const control of dialog.querySelectorAll('.design-preview button,.design-preview input,.design-preview select'))control.disabled=true;
  dialog.querySelector('.design-result').textContent='Valid v1 '+(this.reviewed.format==='deckcraft.workspace'?'workspace. Applying replaces the current canvas only.':'component. Applying adds a new view.');
  dialog.querySelector('[data-editor="apply-design"]').disabled=false;
 }
 coordinate(value,max) {const unit=this.store.getWorkspace().snapshot.snap?20:1;return Math.max(0,Math.min(max,Math.round(value/unit)*unit));}
 pointerDown(event) {
  if(event.button!==0||!this.store.getWorkspace().active||!this.ui.editing)return;
  const handle=event.target.closest('.widget-grip,.widget-resize');if(!handle)return;
  event.preventDefault();const element=handle.closest('[data-item-id]'),item=this.item(element.dataset.itemId);if(!item)return;
  this.ui.selected=item.id;this.drag={id:item.id,item:structuredClone(item),element,startX:event.clientX,startY:event.clientY,resize:handle.classList.contains('widget-resize'),pointer:event.pointerId};handle.setPointerCapture(event.pointerId);
 }
 pointerMove(event) {
  const d=this.drag;if(!d||d.pointer!==event.pointerId)return;
  const dx=event.clientX-d.startX,dy=event.clientY-d.startY;
  d.patch=d.resize?{width:Math.max(320,this.coordinate(d.item.width+dx,1600)),height:Math.max(160,this.coordinate(d.item.height+dy,1600))}:{x:this.coordinate(d.item.x+dx,2400),y:this.coordinate(d.item.y+dy,4800)};
  for(const [key,value] of Object.entries(d.patch))d.element.style[{x:'left',y:'top'}[key]||key]=value+'px';
 }
 pointerUp(event) {
  const d=this.drag;if(!d||d.pointer!==event.pointerId)return;this.drag=null;this.suppressClick=true;
  if(d.patch&&this.item(d.id))this.act({type:'item',id:d.id,patch:d.patch});else this.redraw();
 }
}
