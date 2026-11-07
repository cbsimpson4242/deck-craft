import test from 'node:test';
import assert from 'node:assert/strict';
import {createSession,reduceSession,restoreSession,serializeSession} from '../src/session.js';
import {createStore,STORAGE_KEY} from '../src/store.js';
import {NativeSession,meterFraction} from '../src/native.js';
import {mixer} from '../src/components.js';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {validateIPC}=require('../desktop/policy.cjs');
test('each band kills and restores independently, persists and restores paused',()=>{
 for(const id of ['A','B','C','D']) for(const band of ['hi','mid','low']){
  let s=createSession();
  s=reduceSession(s,{type:'deck',deck:id,field:band,value:73});
  s=reduceSession(s,{type:'eq-kill',deck:id,band});
  assert.equal(s.decks[id][band],0);
  assert.equal(s.decks[id].eqRestore[band],73);
  s=restoreSession(serializeSession(s)).state;
  assert.equal(s.decks[id].playing,false);
  s=reduceSession(s,{type:'eq-kill',deck:id,band});
  assert.equal(s.decks[id][band],73);
  assert.equal(s.decks[id].eqRestore[band],null);
 }
});
test('zero knob restores neutral; manual move cancels kill memory',()=>{
 let s=reduceSession(createSession(),{type:'deck',deck:'A',field:'low',value:0});
 s=reduceSession(s,{type:'eq-kill',deck:'A',band:'low'});
 assert.equal(s.decks.A.low,50);
 s=reduceSession(s,{type:'eq-kill',deck:'A',band:'low'});
 s=reduceSession(s,{type:'deck',deck:'A',field:'low',value:62});
 assert.equal(s.decks.A.eqRestore.low,null);
});
test('all four assignments survive layouts and old snapshots keep original routing',()=>{
 let s=createSession();
 assert.deepEqual(Object.values(s.decks).map(d=>d.assign),['left','right','thru','thru']);
 for(const id of ['A','B','C','D']) s=reduceSession(s,{type:'assign',deck:id,value:'right'});
 const decks=s.decks;
 s=reduceSession(s,{type:'layout',value:'signal-one'});
 assert.equal(s.decks,decks);
 const saved=JSON.parse(serializeSession(s));
 for(const d of Object.values(saved.decks)) delete d.assign;
 assert.deepEqual(Object.values(restoreSession(JSON.stringify(saved)).state.decks).map(d=>d.assign),['left','right','thru','thru']);
});
test('semantic mixer IPC rejects extra fields, nonfinite values and invalid routing',()=>{
 for(const deck of ['A','B','C','D']){
  for(const side of ['left','right','thru']) assert.doesNotThrow(()=>validateIPC({type:'assign',deck,side}));
  for(const band of ['hi','mid','low']) assert.doesNotThrow(()=>validateIPC({type:'eq',deck,band,value:0}));
 }
 for(const req of [{type:'eq',deck:'A',band:'high',value:0},{type:'eq',deck:'A',band:'hi',value:NaN},{type:'assign',deck:'C',side:'both'},{type:'assign',deck:'D',side:'left',path:'/x'}]) assert.throws(()=>validateIPC(req));
});
test('meters reject nonfinite input and represent real linear peaks logarithmically',()=>{
 for(const v of [undefined,null,NaN,Infinity,-1,0]) assert.equal(meterFraction(v),0);
 assert.ok(meterFraction(.1)>meterFraction(.01));
 assert.ok(meterFraction(1)>.9);
 assert.equal(meterFraction(16),1);
});
test('shared mixer renders independent accessible band and assignment controls',()=>{
 const html=mixer(createSession(),['A','B','C','D']);
 assert.equal((html.match(/data-action="eq-kill"/g)||[]).length,12);
 assert.equal((html.match(/data-action="assign"/g)||[]).length,12);
 assert.equal((html.match(/data-vu-deck=/g)||[]).length,4);
});
test('native kill beats pending slider and remembers acknowledged value',async()=>{
 const store=createStore({getItem(){return null},setItem(){}});
 store.dispatch({type:'deck',deck:'A',field:'hi',value:72});
 let seq=0;
 const calls=[];
 let n;
 const bridge={onEvent(){},async command(r){
  calls.push(r);
  const decks=Object.entries(store.get().decks).map(([id,d])=>({id,trackId:null,playing:false,level:d.level,gain:d.gain,hi:d.hi,mid:d.mid,low:d.low,assign:d.assign}));
  if(r.type==='eq') decks.find(d=>d.id===r.deck)[r.band]=r.value;
  return {ok:true,snapshot:{ready:true,engineId:'mixer-test',seq:++seq,decks,crossfader:50,capabilities:{channelEq:true,channelMeters:true,crossfaderAssign:true}}};
 }};
 n=new NativeSession(bridge,store,{redraw(){},say(){}});
 n.initialized=true;
 n.accept((await bridge.command({type:'status'})).snapshot,true);
 n.dispatch({type:'deck',deck:'A',field:'hi',value:81});
 n.dispatch({type:'eq-kill',deck:'A',band:'hi',kill:true});
 await new Promise(r=>setTimeout(r,70));
 assert.equal(store.get().decks.A.hi,0);
 assert.equal(store.get().decks.A.eqRestore.hi,72);
 assert.ok(!calls.some(r=>r.value===81));
 await n.perform({type:'eq-kill',deck:'A',band:'hi',kill:false});
 assert.equal(store.get().decks.A.hi,72);
});
test('native mixer receipts persist immediately while playing',()=>{
 const saved=new Map();
 const s=createStore({getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)});
 s.dispatch({type:'native-clock',snapshot:{ready:true,decks:[{id:'C',level:48,assign:'left',hi:0}],crossfader:32}});
 const restored=restoreSession(saved.get(STORAGE_KEY)).state;
 assert.equal(restored.decks.C.assign,'left');assert.equal(restored.decks.C.hi,0);assert.equal(restored.mixer.crossfader,32);
});
test('audio client validates mixer telemetry, silences stopped meters and rejects stale frames',()=>{
 const {AudioClient}=require('../desktop/audio-client.cjs');
 const client=()=>Object.assign(Object.create(AudioClient.prototype),{closed:false,sequence:0,engineId:null,emit(){},sourceId:'test-source'});
 const frame=()=>({engineId:'engine-ab-cd',seq:1,kind:'state',snapshot:{ready:true,decks:['A','B','C','D'].map(id=>({id,playing:true,gain:50,hi:50,mid:50,low:50,assign:'left',meter:{l:.4,r:.2}}))}});
 for(const patch of [{meter:{l:17,r:0}},{meter:{l:NaN,r:0}},{meter:{l:0,r:0,path:'/x'}},{gain:101},{assign:'both'}]){
  const f=frame();Object.assign(f.snapshot.decks[0],patch);
  assert.throws(()=>client().accept(f),/invalid_engine_snapshot/);
 }
 const c=client(),f=frame(); f.snapshot.decks[0].playing=false;c.accept(f);
 assert.deepEqual(c.snapshot.decks[0].meter,{l:0,r:0});
 assert.deepEqual(c.snapshot.decks[1].meter,{l:.4,r:.2});
 assert.throws(()=>c.accept(frame()),/invalid_engine_sequence/);
});
test('disconnect discards deferred mixer gestures before reconnect',async()=>{
 const store=createStore({getItem(){return null},setItem(){}});
 const calls=[];
 const n=new NativeSession({onEvent(){},async command(r){calls.push(r);return {ok:true}}},store,{redraw(){},say(){}});
 n.initialized=true;
 n.dispatch({type:'deck',deck:'A',field:'hi',value:81});
 n.dispatch({type:'mixer',field:'crossfader',value:14});
 n.accept({sourceId:'closed-source',engineId:'closed-engine',seq:1,terminal:true,ready:false,decks:[]},true);
 await new Promise(r=>setTimeout(r,70));
 assert.deepEqual(calls,[]);
 assert.equal(n.pending.size,0);
});
