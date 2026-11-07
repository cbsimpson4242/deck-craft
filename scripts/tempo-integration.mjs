import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AudioClient} from '../desktop/audio-client.cjs';
import {LocalLibrary} from '../desktop/library.cjs';
import {inspectAudio} from '../desktop/importer.cjs';
if(!process.env.ALSA_CONFIG_PATH||!process.env.PULSE_SERVER?.startsWith('unix:')||!process.env.DECKCRAFT_TEST_PAREC)throw Error('Explicit isolated null sink required.');
const dir=await mkdtemp(path.join(os.tmpdir(),'deckcraft-tempo-')),binary=process.env.DECKCRAFT_TEST_ENGINE||path.resolve('native/target/debug/deck-craft-audio');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const audio=new AudioClient(binary),lib=new LocalLibrary(path.join(dir,'private')),checks=[];
const chunks=[];let bytes=0;
const recorder=spawn(process.env.DECKCRAFT_TEST_PAREC,['--server='+process.env.PULSE_SERVER,'--device=deckcraft_test.monitor','--raw','--format=s16le','--rate=48000','--channels=2','--latency-msec=20'],{stdio:['ignore','pipe','pipe']});
recorder.stdout.on('data',b=>{chunks.push(b);bytes+=b.length;});recorder.stderr.on('data',()=>{});
const request=c=>audio.request(c),deck=s=>s.decks[0];
async function until(fn,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const x=await fn();if(x)return x;await delay(30);}throw Error('Timed out '+label);}
function wav(seconds,bpm=0,offset=.17){const r=48000,frames=Math.round(seconds*r),b=Buffer.alloc(44+frames*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(r,24);b.writeUInt32LE(r*4,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(frames*4,40);for(let i=0;i<frames;i++){const t=i/r;const phase=bpm?(t-offset)%(60/bpm):0;const amp=bpm?(t>=offset&&phase>=0&&phase<.025?.7:0):.3;const v=Math.round(Math.sin(2*Math.PI*(bpm?900:440)*t)*amp*32767);b.writeInt16LE(v,44+i*4);b.writeInt16LE(v,46+i*4);}return b;}
async function source(name,seconds,bpm){const f=path.join(dir,name+'.wav');await writeFile(f,wav(seconds,bpm));const r=await lib.select(f);const meta=await inspectAudio(binary,r);lib.commit(r.id,meta);return {...r,meta};}
function frequency(b){const periods=[];let previous=null;for(let i=4;i<b.length;i+=4)if(b.readInt16LE(i-4)<=0&&b.readInt16LE(i)>0){if(previous!==null)periods.push((i-previous)/4);previous=i;}periods.sort((a,b)=>a-b);return 48000/periods[Math.floor(periods.length/2)];}
try{
 await until(async()=> (await request({type:'status'})).ready,'output');
 const tone=await source('Tone',3,0);assert.equal(tone.meta.beatGrid,null,'steady tone must not fabricate BPM');
 const a=await source('Clicks 120',30,120),b=await source('Clicks 126',30,126);
 assert.ok(Math.abs(a.meta.beatGrid.bpm-120)<.2);assert.ok(Math.abs(b.meta.beatGrid.bpm-126)<.5);
 checks.push({analysis:{a:a.meta.beatGrid,b:b.meta.beatGrid,steadyTone:null}});
 const ffmpeg=process.env.FFMPEG;if(!ffmpeg)throw Error('FFMPEG required for generated embedded-art fixture.');
 const cover=path.join(dir,'generated-cover.png'),album=path.join(dir,'generated-album.flac');
 await exec(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=64x64','-frames:v','1','-threads','1',cover],{timeout:20000});
 await exec(ffmpeg,['-nostdin','-v','error','-i',tone.path,'-i',cover,'-map','0:a','-map','1:v','-c:a','flac','-c:v','copy','-disposition:v','attached_pic',album],{timeout:20000});
 const artRecord=await lib.select(album),artMeta=await inspectAudio(binary,artRecord);
 assert.match(artMeta.artwork,/^data:image\/png;base64,iVBOR/);assert.ok(artMeta.artwork.length<=22000);
 lib.commit(artRecord.id,artMeta);assert.ok(await lib.save());const restored=new LocalLibrary(lib.directory);await restored.restore();assert.equal(restored.get(artRecord.id).artwork,artMeta.artwork);
 checks.push('real FLAC embedded artwork extracted, sanitized and restored privately');

 for(const pitchLock of [false,true])for(const rate of [.92,1.08]){
   await request({type:'load',deck:'A',trackId:tone.id,path:tone.path,identity:tone.identity});
   await request({type:'tempo',deck:'A',rate,pitchLock});
   await request({type:'seek',deck:'A',position:0});
   const begin=bytes,start=performance.now();await request({type:'play',deck:'A'});
   await delay(1600);const now=Buffer.concat(chunks);const middle=now.subarray(Math.max(begin,now.length-48000*4),now.length);
   const hz=frequency(middle);assert.ok(Math.abs(hz-(pitchLock?440:440*rate))<3,JSON.stringify({hz,rate,pitchLock}));
   await until(async()=>!deck(await request({type:'status'})).playing,'natural end',6000);
   const elapsed=(performance.now()-start)/1000;
   console.log("mode",JSON.stringify({elapsed,rate,pitchLock,native:deck(await request({type:"status"}))}));
   assert.equal(deck(await request({type:"status"})).underrunSamples,0,"producer must keep up; output-driver gaps are recorded separately");
   await delay(350);const captured=Buffer.concat(chunks).subarray(begin);let first=-1,last=-1;
   for(let i=0;i<captured.length;i+=4)if(Math.abs(captured.readInt16LE(i))>30){if(first<0)first=i;last=i;}
   const duration=(last-first)/4/48000;
   let silence=0,run=0;for(let i=first;i<=last;i+=4){if(Math.abs(captured.readInt16LE(i))<2)run++;else {if(run>=48)silence+=run;run=0;}}
   const driverGapSeconds=silence/48000,signalDuration=duration-driverGapSeconds;
   assert.ok(Math.abs(signalDuration-3/rate)<.04,JSON.stringify({duration,signalDuration,driverGapSeconds,rate}));

   checks.push({rate,pitchLock,hz,capturedDuration:duration,signalDuration,driverGapSeconds,wallDuration:elapsed,underrunSamples:deck(await request({type:"status"})).underrunSamples});
 }

 // Combined tempo + channel strip: full-kill EQ, the sweep filter and meters act on the tempo-processed signal.
 // The capture is a 60 Hz + 1 kHz + 10 kHz mix on deck C; HI and LOW are killed, so only the mid tone may remain
 // (at 1000 Hz with pitch lock, at 1080 Hz without). The strip values must survive tempo and lock changes.
 {
  const r=48000,seconds=14,frames=r*seconds,buf=Buffer.alloc(44+frames*4);
  buf.write('RIFF');buf.writeUInt32LE(buf.length-8,4);buf.write('WAVEfmt ',8);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(2,22);buf.writeUInt32LE(r,24);buf.writeUInt32LE(r*4,28);buf.writeUInt16LE(4,32);buf.writeUInt16LE(16,34);buf.write('data',36);buf.writeUInt32LE(frames*4,40);
  for(let i=0;i<frames;i++){const t=i/r,v=Math.round((Math.sin(2*Math.PI*60*t)+Math.sin(2*Math.PI*1000*t)+Math.sin(2*Math.PI*10000*t))*0.2*32767);buf.writeInt16LE(v,44+i*4);buf.writeInt16LE(v,46+i*4);}
  const triFile=path.join(dir,'Tri.wav');await writeFile(triFile,buf);const tri=await lib.select(triFile);lib.commit(tri.id,await inspectAudio(binary,tri));
  const level=(b,hz)=>{const n=Math.floor(b.length/4);let re=0,im=0;const w=2*Math.PI*hz/r;for(let i=0;i<n;i++){const v=b.readInt16LE(i*4)/32768;re+=v*Math.cos(w*i);im+=v*Math.sin(w*i);}return 2*Math.hypot(re,im)/n;};
  const lastSeconds=sec=>{const all=Buffer.concat(chunks);return all.subarray(Math.max(0,all.length-Math.round(sec*r)*4));};
  const results=[];
  for(const [pitchLock,rate] of [[true,1.08],[false,1.08],[true,.92]]){
   await request({type:'load',deck:'C',trackId:tri.id,path:tri.path,identity:tri.identity});
   for(const [type,value] of [['hi',0],['low',0],['mid',50],['gain',50],['filter',50]])await request({type,deck:'C',value});
   await request({type:'tempo',deck:'C',rate,pitchLock});
   await request({type:'seek',deck:'C',position:0});
   await request({type:'play',deck:'C'});
   const p0=(await request({type:'status'})).decks[2].position,t0=performance.now();
   await delay(2200);
   let st=(await request({type:'status'})).decks[2];
   const clock=(st.position-p0)/((performance.now()-t0)/1000);
   assert.ok(Math.abs(clock-rate)<.05,'source clock follows tempo '+JSON.stringify({clock,rate}));
   assert.ok(st.meter.l>0.001&&st.meter.r>0.001,'meters read the signal after strip and tempo: '+JSON.stringify(st.meter));
   assert.deepEqual([st.hi,st.low,st.mid,st.gain,st.filter,st.rate,st.pitchLock],[0,0,50,50,50,rate,pitchLock]);
   const expectedMid=pitchLock?1000:1000*rate,seg=lastSeconds(1);
   const lo=level(seg,pitchLock?60:60*rate),mid=level(seg,expectedMid),hi=level(seg,pitchLock?10000:10000*rate);
   assert.ok(mid>0.01&&mid/Math.max(lo,1e-9)>60&&mid/Math.max(hi,1e-9)>60,'only the mid tone survives HI/LOW kill under tempo '+JSON.stringify({pitchLock,rate,lo,mid,hi}));
   // A tempo change while playing must not disturb the strip, and the strip must keep shaping the new signal.
   const newRate=pitchLock?1.0:.95;
   await request({type:'tempo',deck:'C',rate:newRate,pitchLock});await delay(900);
   st=(await request({type:'status'})).decks[2];assert.deepEqual([st.hi,st.low,st.rate],[0,0,newRate]);
   const seg2=lastSeconds(.4),mid2=level(seg2,pitchLock?1000:1000*newRate),lo2=level(seg2,pitchLock?60:60*newRate);
   assert.ok(mid2>0.01&&mid2/Math.max(lo2,1e-9)>40,'EQ keeps shaping after a live tempo change '+JSON.stringify({mid2,lo2}));
   // Restoring the killed bands brings the low tone back through the same stretched signal.
   await request({type:'low',deck:'C',value:50});await delay(500);
   const lo3=level(lastSeconds(.4),pitchLock?60:60*newRate);assert.ok(lo3>lo2*20,'LOW restored under tempo '+JSON.stringify({lo2,lo3}));
   await request({type:'pause',deck:'C'});await delay(300);
   st=(await request({type:'status'})).decks[2];assert.deepEqual([st.meter.l,st.meter.r],[0,0],'paused meters are silent');
   assert.equal(st.underrunSamples,0,'producer keeps up with strip + stretch');
   results.push({pitchLock,rate,newRate,clock,lo,mid,hi,lo2,mid2,lo3});
  }
  checks.push({combinedTempoAndChannelStrip:results});
 }
 await request({type:'load',deck:'A',trackId:a.id,path:a.path,identity:a.identity});
 await request({type:'load',deck:'B',trackId:b.id,path:b.path,identity:b.identity});
 await until(async()=>{const s=await request({type:'status'});return s.decks[0].beatGrid&&s.decks[1].beatGrid;},'native analysis');
 await request({type:'tempo',deck:'A',rate:1,pitchLock:false});await request({type:'tempo',deck:'B',rate:1,pitchLock:false});
 await assert.rejects(request({type:'sync',deck:'B'}),/sync_master_required/);
 await request({type:'master',deck:'A'});
 await request({type:'seek',deck:'A',position:5.21});await request({type:'seek',deck:'B',position:8.4});
 await request({type:'play',deck:'A'});await request({type:'play',deck:'B'});await delay(250);
 let s=await request({type:'sync',deck:'B'});assert.equal(s.decks[1].synced,true);
 assert.ok(Math.abs(s.decks[1].rate-120/126)<.01);
 await delay(600);s=await request({type:'status'});
 const phase=d=>((d.position-d.beatGrid.offset)*d.beatGrid.bpm/60)%1;
 const diff=Math.abs(phase(s.decks[0])-phase(s.decks[1]));assert.ok(Math.min(diff,1-diff)<.12,JSON.stringify(s.decks));
 checks.push({syncPhaseErrorBeats:Math.min(diff,1-diff),rates:s.decks.slice(0,2).map(d=>d.rate)});
 await request({type:'seek',deck:'A',position:7.1});
 assert.equal((await request({type:'status'})).decks[1].synced,false,'master seek invalidates follower phase alignment');
 await request({type:'sync',deck:'B'});
 assert.equal((await request({type:'status'})).decks[1].synced,true);
 await request({type:'pause',deck:'A'});
 assert.equal((await request({type:'status'})).decks[1].synced,false,'master pause invalidates follower phase alignment');
 await request({type:'pause',deck:'B'});await delay(50);
 const before=(await request({type:'status'})).decks[0];
 await request({type:'tempo',deck:'B',rate:1.03,pitchLock:true});await request({type:'seek',deck:'B',position:9.2});
 const after=(await request({type:'status'})).decks[0];assert.ok(Math.abs(before.position-after.position)<.002,"another deck must not seek or restart");assert.equal(before.loadGeneration,after.loadGeneration);
 const paused=(await request({type:'status'})).decks[1];assert.equal(paused.playing,false);assert.ok(Math.abs(paused.position-9.2)<.001);assert.equal(paused.rate,1.03);assert.equal(paused.pitchLock,true);
 await request({type:'load',deck:'C',trackId:tone.id,path:tone.path,identity:tone.identity});
 await assert.rejects(request({type:'sync',deck:'C'}),/beat_grid_unavailable/);
 await assert.rejects(request({type:'tempo',deck:'A',rate:1.2,pitchLock:true}),/invalid_tempo/);
 await assert.rejects(request({type:'tempo',deck:'A',rate:1,pitchLock:true,extra:1}),/invalid_request/);
 checks.push('paused tempo/lock seek preserves source clock and other deck; native rejects unavailable grids, missing master, out-of-range rates and extra command fields');
 if(process.env.DECKCRAFT_EVIDENCE_DIR){await writeFile(path.join(process.env.DECKCRAFT_EVIDENCE_DIR,'tempo-capture.s16le'),Buffer.concat(chunks));await writeFile(path.join(process.env.DECKCRAFT_EVIDENCE_DIR,'tempo-results.json'),JSON.stringify(checks,null,2));}
 console.log(JSON.stringify(checks,null,2));
}finally{if(process.env.DECKCRAFT_EVIDENCE_DIR)await writeFile(path.join(process.env.DECKCRAFT_EVIDENCE_DIR,'tempo-partial-results.json'),JSON.stringify(checks,null,2));if(process.env.DECKCRAFT_EVIDENCE_DIR)await writeFile(path.join(process.env.DECKCRAFT_EVIDENCE_DIR,'tempo-last-capture.s16le'),Buffer.concat(chunks));await audio.stop();recorder.kill('SIGTERM');await delay(80);await rm(dir,{recursive:true,force:true});}
