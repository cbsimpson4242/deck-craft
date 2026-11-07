import test from 'node:test';
import assert from 'node:assert/strict';
import { waveViewport, wheelZoomLevel } from '../src/wave-zoom.js';
import { paintWaveBox } from '../src/components.js';

test('wheel zoom is reversible, bounded and normalizes pixel, line and page deltas',()=>{
 const up=wheelZoomLevel(5,{deltaY:-120});
 assert.ok(up>5);assert.ok(Math.abs(wheelZoomLevel(up,{deltaY:120})-5)<1e-10);
 assert.equal(wheelZoomLevel(1,{deltaY:1000}),1);
 assert.equal(wheelZoomLevel(32,{deltaY:-1000}),32);
 assert.equal(wheelZoomLevel(5,{deltaY:-48}),wheelZoomLevel(5,{deltaY:-3,deltaMode:1}));
 assert.equal(wheelZoomLevel(5,{deltaY:-120}),wheelZoomLevel(5,{deltaY:-1,deltaMode:2}));
 for(const event of [{deltaY:0},{deltaY:NaN},{deltaY:Infinity},{deltaY:-30,ctrlKey:true},{deltaY:-30,metaKey:true},{deltaY:1,deltaX:30}])assert.equal(wheelZoomLevel(5,event),5);
});

test('zoomed timelines keep a bounded time window; scrolling detail keeps its fixed playhead',()=>{
 for(const ratio of [0,.1,.5,.99,1])for(const zoom of [1,2,5,32]){
  const v=waveViewport(ratio,zoom);
  assert.ok(v.start>=0&&v.end<=1+1e-10);assert.ok(Math.abs(v.end-v.start-1/zoom)<1e-10);
  assert.ok(Math.abs(v.start+v.marker/zoom-ratio)<1e-10);
  assert.ok(Math.abs(waveViewport(ratio,zoom,true).marker-.5)<1e-10);
 }
 assert.deepEqual(waveViewport(NaN,Infinity),{zoom:1,start:0,end:1,marker:0});
});

test('clock paint aligns marker and seek bounds with the displayed time interval, leaving full overview intact',()=>{
 const props={},marker={style:{}},seek={};
 const box={dataset:{waveZoom:'4',waveDuration:'200'},classList:{contains:()=>false},style:{setProperty:(k,v)=>props[k]=v},querySelector:s=>s==='.position-marker'?marker:s==='.wave-seek'?seek:null};
 paintWaveBox(box,.5);
 assert.equal(Number(seek.min),75);assert.equal(Number(seek.max),125);assert.equal(Number(seek.value),100);
 assert.equal(marker.style.left,'50%');assert.equal(Number(props['--wave-start']),.375);
 box.classList.contains=name=>name==='overview';paintWaveBox(box,.5);
 assert.equal(Number(seek.min),0);assert.equal(Number(seek.max),200);
 // A focused seek must not slide its input mapping while the position changes.
 const previous=globalThis.document;
 try {
  box.classList.contains=()=>false;globalThis.document={activeElement:seek};seek.min='75';seek.max='125';
  paintWaveBox(box,.55);assert.equal(seek.min,'75');assert.equal(seek.max,'125');
  assert.equal(Number(props['--wave-start']),.375);assert.ok(Math.abs(parseFloat(marker.style.left)-70)<1e-8);
 } finally {if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});
