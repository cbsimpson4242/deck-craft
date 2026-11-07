import { TRACKS, waveDetailById } from './catalog.js';

// ---- Waveform sampling and canvas painting ---------------------------------------------------
// Presentation only. Local files draw decoded PCM data, colored by amplitude only (a fixed design
// palette, not frequency analysis): the persisted 512 peaks, or — when the native engine has sent
// them for the loaded deck — a finer session-only envelope of peak and RMS bins. Demo tracks use a
// deterministic synthetic fixture. Sampling is for the displayed time interval at device-pixel
// resolution, so zooming never stretches a fixed set of strokes across the viewport.
const mulberry = seed => {let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};};
const RAMPS=[['#c52c16','#d63a19','#ad2417','#e24f1c','#bd3015'],['#be3598','#d14c9a','#a82c92','#cf3f84'],['#9650cc','#8044c1','#aa62d3','#6f3db5']];
const INTRO_COLORS=['#2fae55','#7fb82c','#d3a824','#dc7e1f','#cf4a22','#1fb2cf','#2a9ad8','#dfa02a','#c8481f'];
const CORE_COLORS=[['#ff8a34','#ff6f2a','#ffb066'],['#f08fcd','#ee7fbd'],['#c9a2ee','#b98fe6'],['#f4e08a']];
const SYNTHETIC_COLUMNS=8192,SYNTHETIC_PULSES=70,MAX_CANVAS_WIDTH=4096,MAX_CANVAS_HEIGHT=512;
let sourceSequence=0;
const syntheticSources=new Map(),peakSources=new WeakMap(),detailSources=new WeakMap();
function syntheticSource(index) {
  if(syntheticSources.has(index))return syntheticSources.get(index);
  const rng=mulberry(41017+index*7919),n=SYNTHETIC_COLUMNS,amp=new Float32Array(n),zone=new Uint8Array(n),grain=new Float32Array(n);
  const gains=Array.from({length:16},()=>.5+.5*rng()),decays=Array.from({length:16},()=>2.3+2.8*rng()),offset=.12+index*.037;
  for(let i=0;i<n;i++){
    const u=i/(n-1),pulse=u*SYNTHETIC_PULSES+offset,k=Math.floor(pulse),phase=pulse-k,slot=k%16;
    const attack=.24+.76*Math.exp(-phase*decays[slot]),off=.2*Math.exp(-Math.pow((phase-.5)/.055,2))*gains[(slot+3)%16],ramp=Math.min(1,.12+phase/.025);
    const spike=rng()<.2*attack?1+.34*rng():1,jitter=phase+(rng()-.5)*.16;
    amp[i]=Math.max(.05,Math.min(1,(attack+off)*ramp*gains[slot]*(u<.215?.58:1)*spike));
    zone[i]=u<.215?3:jitter<.3?0:jitter<.58?1:2;grain[i]=rng();
  }
  const source={id:++sourceSequence,n,amp,rms:null,zone,grain,texture:true,interpolate:false,offset};syntheticSources.set(index,source);return source;
}
const floatPeaks=peaks=>{let source=peakSources.get(peaks);if(!source){source={id:++sourceSequence,n:peaks.length,amp:Float32Array.from(peaks),rms:null,zone:null,grain:null,texture:false,interpolate:true};peakSources.set(peaks,source);}return source;};
function detailSource(detail) {
  let source=detailSources.get(detail);if(source)return source;
  const amp=new Float32Array(detail.bins),rms=new Float32Array(detail.bins);
  for(let i=0;i<detail.bins;i++){amp[i]=detail.peak[i]/255;rms[i]=Math.min(amp[i],detail.rms[i]/255);}
  source={id:++sourceSequence,n:detail.bins,amp,rms,zone:null,grain:null,texture:false,interpolate:false,detail:true};detailSources.set(detail,source);return source;
}
// The drawable data for a deck's track, or null (nothing is invented for a local file without PCM peaks).
export function waveSource(track) {
  if(!track)return null;
  if(!track.local)return syntheticSource(Math.max(0,TRACKS.indexOf(track)));
  const detail=waveDetailById(track.id);
  if(detail)return detailSource(detail);
  return Array.isArray(track.peaks)&&track.peaks.length===512?floatPeaks(track.peaks):null;
}
// Sample the track-fraction interval [from,to] into `pixels` columns. Columns wider than a data bin
// keep the maximum (so a transient never disappears); narrower columns hold the bin's own value —
// or interpolate between coarse persisted peaks. Columns outside the track are absent (-1).
export function sampleWave(source,from,to,pixels) {
  const amp=new Float32Array(pixels).fill(-1),core=new Float32Array(pixels).fill(-1),bin=new Int32Array(pixels),n=source.n,step=(to-from)/pixels,a=source.amp,r=source.rms;
  for(let c=0;c<pixels;c++){
    const t0=from+c*step,t1=t0+step;
    if(!(t1>0)||!(t0<1))continue;
    const b0=Math.max(0,t0)*n,b1=Math.min(1,t1)*n;
    if(b1-b0<1){
      const centre=(b0+b1)/2;
      if(source.interpolate){
        const x=Math.max(0,Math.min(n-1,centre-.5)),lo=Math.floor(x),hi=Math.min(n-1,lo+1),f=x-lo;
        amp[c]=a[lo]*(1-f)+a[hi]*f;bin[c]=f<.5?lo:hi;
      } else {
        const i=Math.min(n-1,Math.floor(centre));amp[c]=a[i];bin[c]=i;if(r)core[c]=r[i];
      }
      continue;
    }
    const i0=Math.floor(b0),i1=Math.min(n-1,Math.max(i0,Math.ceil(b1)-1));
    let peak=-1,at=i0,squares=0;
    for(let i=i0;i<=i1;i++){if(a[i]>peak){peak=a[i];at=i;}if(r)squares+=r[i]*r[i];}
    amp[c]=peak;bin[c]=at;if(r)core[c]=Math.sqrt(squares/(i1-i0+1));
  }
  return {amp,core,bin,step};
}
// Ruler positions as track fractions inside [from,to]. Timeline rulers divide the whole track;
// scrolling rulers follow the synthetic pulse grid or whole-second time ticks for local audio.
export function waveRuler(track,source,scroll,from,to) {
  const marks=[],add=(u,strong)=>{if(u>=from&&u<=to)marks.push({u,strong});};
  if(!scroll){for(let i=0;i<=16;i++)add(i/16,i%4===0);return marks;}
  if(!track.local){let i=0;for(let k=0;k<SYNTHETIC_PULSES+2;k++){const u=(k-source.offset)/SYNTHETIC_PULSES;if(u>=0&&u<=1){add(u,i%4===0);i++;}}return marks;}
  const every=Math.max(10,Math.ceil(track.duration/120/10)*10);
  for(let t=every;t<track.duration;t+=every)add(t/track.duration,t%(every*6)===0);
  return marks;
}
function layerAdd(layer,color,alpha,x,top,bottom) {
  const key=color+'|'+alpha;let list=layer.get(key);if(!list){list=[];layer.set(key,list);}list.push(x,top,bottom);
}
function drawLayer(ctx,layer) {
  for(const [key,list] of layer){
    const [color,alpha]=key.split('|');ctx.fillStyle=color;ctx.globalAlpha=Number(alpha);ctx.beginPath();
    for(let i=0;i<list.length;i+=3)ctx.rect(list[i],list[i+1],1,Math.max(1,list[i+2]-list[i+1]));
    ctx.fill();
  }
  ctx.globalAlpha=1;
}
// Pure drawing of sampled columns into a 2D context of W×H device pixels.
export function drawWave(ctx,W,H,dpr,source,samples,{ruler=[],from=0,line='#8ce3c4',tint=''}={}) {
  ctx.clearRect(0,0,W,H);
  if(tint)return drawTinted(ctx,W,H,dpr,source,samples,{ruler,from,line,tint});
  const mid=H/2,reach=mid*43/45,floor=.6*dpr,step=samples.step;
  for(const {u,strong} of ruler){const x=Math.round((u-from)/step);if(x<0||x>=W)continue;ctx.globalAlpha=strong?.3:.14;ctx.fillStyle='#ffffff';ctx.fillRect(x,0,1,H);}
  ctx.globalAlpha=1;
  const outer=new Map(),inner=new Map(),extra=new Map(),n=source.n;
  for(let c=0;c<W;c++){
    const a=samples.amp[c];
    if(a<0||(!source.texture&&a<=0))continue; // outside the track, or digital silence
    const i=samples.bin[c],z=source.zone?source.zone[i]:a>.62?0:a>.34?1:2,g=source.grain?source.grain[i]:.5;
    const color=z===3?INTRO_COLORS[Math.min(8,Math.floor(i/n/.215*9))]:RAMPS[z][i%RAMPS[z].length],coreColor=CORE_COLORS[z][i%CORE_COLORS[z].length];
    const ragged=source.texture?.62+.38*g:1,up=Math.max(floor,a*reach*ragged),down=Math.max(floor,a*reach*(source.texture?ragged:.94));
    const dropout=source.texture&&g<(z===0?.09:z===1?.054:.03),top=up*.9,bottom=down*.9;
    const add=(layer,col,alpha,u,d)=>layerAdd(layer,col,alpha,c,Math.round(mid-u),Math.round(mid+d));
    if(!dropout)add(outer,color,.92,top,bottom);
    // Real RMS (when decoded) sets the inner core; otherwise a fixed fraction of the envelope.
    const rms=samples.core[c];
    if(rms>=0){const h=Math.max(floor*.5,rms*reach*.9);add(inner,coreColor,.74,Math.min(top,h),Math.min(bottom,h*.94));}
    else add(inner,coreColor,.74,up*(source.texture?.34:.52),down*(source.texture?.34:.52));
    if(source.texture){
      add(extra,color,.7,up*(.2+.8*((g*7.13)%1)),down*(.2+.8*((g*3.71)%1)));
      if(z===0&&g>.975)add(extra,'#ffe3b8',.8,up*((g*11.3)%1),down*((g*5.9)%1));
      if(dropout)add(extra,'#050506',.6,up*.55,down*.55);
    }
  }
  drawLayer(ctx,outer);drawLayer(ctx,inner);drawLayer(ctx,extra);
  ctx.globalAlpha=.5;ctx.fillStyle=line;ctx.fillRect(0,Math.floor(mid-dpr/2),W,Math.max(1,Math.round(dpr)));ctx.globalAlpha=1;
}
// Console style: three nested contours of the same amplitude envelope in the deck's own colour
// (outer shell, mid body, white core). Still amplitude only: no frequency analysis is implied.
const TINT_LAYERS=[[1,.55,null],[.62,.95,null],[.3,.92,'#ffffff']];
function drawTinted(ctx,W,H,dpr,source,samples,{ruler,from,line,tint}) {
  const mid=H/2,reach=mid*43/45,floor=.6*dpr,step=samples.step;
  for(const {u,strong} of ruler){const x=Math.round((u-from)/step);if(x<0||x>=W)continue;ctx.globalAlpha=strong?.26:.1;ctx.fillStyle='#ffffff';ctx.fillRect(x,0,1,H);}
  TINT_LAYERS.forEach(([scale,alpha,color],layer)=>{
    ctx.globalAlpha=alpha;ctx.fillStyle=color||tint;ctx.beginPath();
    for(let c=0;c<W;c++){
      const a=samples.amp[c];
      if(a<0||(!source.texture&&a<=0))continue;
      const g=source.grain?source.grain[samples.bin[c]]:.5,ragged=source.texture?.7+.3*g:1;
      // The white core stays inside the shell so the deck hue is always visible at the envelope's edge.
      const core=layer===2&&samples.core[c]>=0?Math.min(a*.7,samples.core[c]*.9)*reach:a*reach*ragged*scale;
      const h=Math.max(floor*(layer+1)*.5,Math.min(a*reach,core));
      ctx.rect(c,Math.round(mid-h),1,Math.max(1,Math.round(h*2)));
    }
    ctx.fill();
  });
  ctx.globalAlpha=.4;ctx.fillStyle=tint||line;ctx.fillRect(0,Math.floor(mid-dpr/2),W,Math.max(1,Math.round(dpr)));ctx.globalAlpha=1;
}
const painted=new WeakMap();
// Paint the visible interval of one box. `viewport` is waveViewport(); the canvas always covers the
// whole box, so a displayed-time → x mapping is (t − viewport.start) / (viewport.end − viewport.start).
export function paintWaveCanvas(canvas,track,viewport,{scroll=false,metrics=null}={}) {
  const source=waveSource(track),view=canvas.ownerDocument?.defaultView;
  if(!source||!view||typeof canvas.getContext!=='function')return false;
  const cssW=metrics?.width??canvas.clientWidth,cssH=metrics?.height??canvas.clientHeight;
  if(!(cssW>0&&cssH>0))return false;
  const dpr=Math.max(1,Math.min(3,view.devicePixelRatio||1)),W=Math.min(MAX_CANVAS_WIDTH,Math.round(cssW*dpr)),H=Math.min(MAX_CANVAS_HEIGHT,Math.round(cssH*dpr)),eff=W/cssW;
  // Anchor pixel columns to a fixed time grid so scrolling does not make peaks shimmer; the
  // playhead alignment error this introduces is at most half a pixel.
  const span=viewport.end-viewport.start,step=span/W,k0=Math.round(viewport.start/step),from=k0*step;
  // The deck hue comes from the active theme; reading it also makes a theme change repaint.
  const tint=metrics?.tint??(view.getComputedStyle?.(canvas).getPropertyValue('--deck')||'').trim();
  const key=[source.id,W,H,k0,step.toPrecision(9),scroll?1:0,tint].join('|');
  if(painted.get(canvas)===key&&canvas.width===W&&canvas.height===H)return true;
  const ctx=canvas.getContext('2d');if(!ctx)return false;
  if(canvas.width!==W||canvas.height!==H){canvas.width=W;canvas.height=H;}
  const samples=sampleWave(source,from,from+step*W,W);
  drawWave(ctx,W,H,eff,source,samples,{ruler:waveRuler(track,source,scroll,from,from+step*W),from,line:canvas.style.getPropertyValue('--wave-line')||'#8ce3c4',tint});
  painted.set(canvas,key);return true;
}
