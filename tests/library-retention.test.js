import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {replaceLocalLibrary,trackById} from '../src/catalog.js';
import {createSession,reduceSession} from '../src/session.js';
import {createViewOptions,renderSession} from '../src/views.js';
import {LibraryController} from '../src/library.js';
import {NativeSession} from '../src/native.js';
const require=createRequire(import.meta.url),{validateIPC}=require('../desktop/policy.cjs');
const id='local-00000000-0000-0000-0000-000000000001';
const track={id,title:'Generated offline fixture.wav',duration:30};
const state=()=>reduceSession(createSession(),{type:'load',deck:'A',trackId:id});
test('offline renderer refuses forgetting a selected deck track before privileged mutation',async()=>{
 replaceLocalLibrary([track]);const current=state(),calls=[];
 const controller=new LibraryController({command:async request=>{calls.push(request);return {ok:true,tracks:[],collections:[]};}},{get:()=>current},{},{redraw:()=>renderSession(current,createViewOptions()),say(){},root:null});
 controller.paint=()=>{};
 await controller.run({type:'forget',trackIds:[id]});
 assert.equal(calls.length,0);assert.equal(trackById(id).title,track.title);assert.match(controller.message,/deck/i);
});
test('catalog replacement refuses an orphaned deck and invalid metadata without clearing valid entries',()=>{
 replaceLocalLibrary([track]);const current=state();
 assert.throws(()=>replaceLocalLibrary([],[],[id]),/deck/i);
 assert.equal(trackById(id).title,track.title);assert.doesNotThrow(()=>renderSession(current,createViewOptions()));
 assert.throws(()=>replaceLocalLibrary([{...track,id:'broken'}]));
 assert.equal(trackById(id).title,track.title);
});
test('initialization retains selected local tracks before checking unavailable audio output',async()=>{
 replaceLocalLibrary([track]);const current=state(),calls=[];
 const bridge={onEvent(){},command:async request=>{calls.push(request);return request.type==='status'?{ok:true,snapshot:{ready:false,engineId:'engine-abc-123',seq:1,decks:[]}}:{ok:true};}};
 const native=new NativeSession(bridge,{get:()=>current,dispatch(){}},{redraw(){},say(){}});
 await native.initialize();
 assert.deepEqual(calls.slice(0,2),[{type:'retain-track',deck:'A',trackId:id},{type:'status'}]);
 assert.equal(native.initialized,true);assert.equal(current.decks.A.playing,false);
});
test('retained deck references accept only semantic deck and opaque track identity',()=>{
 assert.deepEqual(validateIPC({type:'retain-track',deck:'A',trackId:id}),{type:'retain-track',deck:'A',trackId:id});
 for(const request of [{type:'retain-track',deck:'Z',trackId:id},{type:'retain-track',deck:'A',trackId:'/music/file.wav'},{type:'retain-track',deck:'A',trackId:id,path:'/music/file.wav'}])assert.throws(()=>validateIPC(request));
});
