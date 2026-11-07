import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {registerLocalTrack,trackById} from '../src/catalog.js';
import {createSession,reduceSession,restoreSession,serializeSession} from '../src/session.js';
import {nativeLibrary} from '../src/library.js';
import {NativeSession} from '../src/native.js';
const require=createRequire(import.meta.url),{validateIPC}=require('../desktop/policy.cjs');
const id='local-12345678-1234-1234-1234-123456789abc';
test('tempo bridge rejects unknown fields, out-of-range rate, nonboolean lock and arbitrary master',()=>{
  for(const rate of [.91,1.09,NaN,Infinity,'1'])assert.throws(()=>validateIPC({type:'tempo',deck:'A',rate,pitchLock:true}));
  assert.throws(()=>validateIPC({type:'tempo',deck:'A',rate:1,pitchLock:1}));
  assert.throws(()=>validateIPC({type:'tempo',deck:'A',rate:1,pitchLock:true,path:'/private'}));
  assert.throws(()=>validateIPC({type:'master',deck:'Z'}));
  assert.deepEqual(validateIPC({type:'sync',deck:'B'}),{type:'sync',deck:'B'});
});
test('analysis survives catalog, native receipts and paused restoration; malformed art is withheld',()=>{
  const t=registerLocalTrack({id,title:'Fixture',duration:100,beatGrid:{bpm:120,offset:.17,confidence:.9},analysisVersion:1,artwork:'https://bad.invalid/a.png'});
  assert.equal(t.bpm,120);assert.equal(t.artwork,null);
  let s=reduceSession(createSession(),{type:'load',deck:'A',trackId:id});
  s=reduceSession(s,{type:'native-clock',snapshot:{ready:true,master:'A',decks:[{id:'A',trackId:id,position:3,playing:true,rate:1.05,pitchLock:false,synced:true}]}});
  assert.equal(s.decks.A.pitch,5);assert.equal(s.decks.A.pitchLock,false);assert.equal(s.master,'A');
  const restored=restoreSession(serializeSession(s)).state;
  assert.equal(restored.decks.A.playing,false);assert.equal(restored.decks.A.pitch,5);assert.equal(restored.decks.A.pitchLock,false);
  const html=nativeLibrary(s);assert.match(html,/120.00/);assert.match(html,/library-artwork/);assert.doesNotMatch(html,/type="checkbox"|load-target|load-cell|LOAD INTO/);
});
test('rapid native tempo gestures coalesce and retain in-flight pitch across lock changes',async()=>{
  registerLocalTrack({id,title:'Fixture',duration:100});let s=reduceSession(createSession(),{type:'load',deck:'A',trackId:id});
  let release;const calls=[];const bridge={onEvent(){},command:async r=>{calls.push(r);if(calls.length===1)await new Promise(resolve=>{release=resolve;});return {ok:true};}};
  const n=new NativeSession(bridge,{get:()=>s,dispatch:a=>{s=reduceSession(s,a);}},{redraw(){},say(){}});
  n.initialized=true;n.mixerSynced=true;n.status={ready:true,decks:[{id:"A",trackId:id}]};
  n.dispatch({type:'deck',deck:'A',field:'pitch',value:4});await new Promise(r=>setImmediate(r));
  n.dispatch({type:'deck',deck:'A',field:'pitchLock',value:false});
  release();await new Promise(r=>setTimeout(r,10));
  assert.equal(calls.length,2);assert.equal(calls[1].rate,1.04);assert.equal(calls[1].pitchLock,false);
});

test('paused native receipts are idempotent and a fresh connection retains the selected master for restoration',()=>{
 let s=reduceSession(createSession(),{type:'load',deck:'A',trackId:id});
 s={...s,master:'A'};
 const receipt={ready:true,master:null,decks:[{id:'A',trackId:id,position:0,playing:false,rate:1,pitchLock:true,synced:false,level:78}]};
 assert.equal(reduceSession(s,{type:'native-clock',snapshot:receipt}),s);
});
