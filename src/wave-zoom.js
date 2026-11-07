// Presentation-only waveform viewport state; never dispatch transport or persist musical state.
export function waveViewport(ratio,zoom,scroll=false) {
  const position=Math.max(0,Math.min(1,Number.isFinite(ratio)?ratio:0));
  const scale=Math.max(1,Math.min(32,Number.isFinite(zoom)?zoom:1));
  const start=scroll?position-.5/scale:Math.max(0,Math.min(1-1/scale,position-.5/scale));
  return {zoom:scale,start,end:start+1/scale,marker:(position-start)*scale};
}
export function wheelZoomLevel(current,event) {
  if(event.ctrlKey||event.metaKey||!Number.isFinite(event.deltaY)||!event.deltaY||Math.abs(event.deltaX||0)>Math.abs(event.deltaY))return current;
  const pixels=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?800:1);
  return Math.max(1,Math.min(32,current*Math.exp(-Math.max(-120,Math.min(120,pixels))/500)));
}
export class WaveZoom {
  constructor(root,repaint) {
    this.levels=new Map();this.repaint=repaint;
    root.addEventListener('wheel',event=>{
      const box=event.target.closest('.wavebox[data-wave-deck]:not(.overview)');
      if(!box||box.closest('.design-preview')||!root.contains(box))return;
      const current=this.level(box),next=wheelZoomLevel(current,event);
      // Consume vertical zoom gestures even at the limit, not horizontal scroll or browser pinch.
      if(event.ctrlKey||event.metaKey||!Number.isFinite(event.deltaY)||!event.deltaY||Math.abs(event.deltaX||0)>Math.abs(event.deltaY))return;
      event.preventDefault();
      if(next===current)return;
      // Release a previous seek gesture before choosing a new visible time interval.
      const active=root.ownerDocument?.activeElement;
      if(active?.matches('.wave-seek')&&box.contains(active))active.blur();
      this.levels.set(this.key(box),next);repaint(box);
    },{passive:false});
  }
  adjust(box,direction) {
    const current=this.level(box),next=Math.max(1,Math.min(32,current*Math.pow(2,direction)));
    if(next!==current){this.levels.set(this.key(box),next);this.repaint(box);}
  }
  key(box) {return box.dataset.waveDeck+':'+(box.classList.contains('scroll')?'detail':'timeline');}
  level(box) {return this.levels.get(this.key(box))??(box.classList.contains('scroll')?5:1);}
  paint(box) {
    if(box.classList.contains('overview'))return;
    const zoom=this.level(box);
    box.dataset.waveZoom=String(zoom);box.style.setProperty('--zoom',String(zoom));
    box.title='Scroll up to zoom in; scroll down to zoom out · '+zoom.toFixed(1)+'×';
    const label=box.querySelector('.zoom-label'),duration=Number(box.dataset.waveDuration);
    if(label)label.textContent=(duration/zoom).toFixed(duration/zoom<10?1:0)+' s';
    const up=box.querySelector('[data-action="zoom-in"]'),down=box.querySelector('[data-action="zoom-out"]');
    if(up)up.disabled=zoom>=32;if(down)down.disabled=zoom<=1;
  }
  preset(boxes,detail) {
    for(const box of boxes)if(!box.classList.contains('overview'))this.levels.set(this.key(box),(box.classList.contains('scroll')?5:1)*(detail?2:1));
  }
}
