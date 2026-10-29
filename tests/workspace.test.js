import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, STORAGE_KEY, WORKSPACE_KEY } from '../src/store.js';

const memory=()=>{const data=new Map();return {data,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};};

test('canvas edits have their own persistence and never mutate the shared session',()=>{
 const storage=memory(),store=createStore(storage),session=structuredClone(store.get());
 assert.equal(typeof store.getWorkspace,'function','store must expose a separate canvas model');
 assert.equal(store.getWorkspace().snapshot.items.length,0);
 store.dispatchWorkspace({type:'active',value:true});
 store.dispatchWorkspace({type:'add',kind:'deck',deck:'C'});
 const item=store.getWorkspace().snapshot.items[0];
 store.dispatchWorkspace({type:'item',id:item.id,patch:{x:80,y:120,width:560}});
 store.dispatchWorkspace({type:'theme',id:item.id,value:'ember'});
 store.dispatchWorkspace({type:'remove',id:item.id});
 assert.deepEqual(store.get(),session);
 assert.equal(storage.getItem(STORAGE_KEY),null,'editing layout must not save or alter musical state');
 store.dispatchWorkspace({type:'undo'});
 assert.equal(store.getWorkspace().snapshot.items[0].design.theme,'ember');
 const restored=createStore(storage);
 assert.deepEqual(restored.getWorkspace().snapshot,store.getWorkspace().snapshot);
 assert.equal(restored.getWorkspace().active,true);
});

test('templates and saved presets are reusable independent designs; undo/redo is bounded',()=>{
 const store=createStore(memory());
 assert.equal(typeof store.dispatchWorkspace,'function');
 store.dispatchWorkspace({type:'add',kind:'deck',deck:'A'});
 const id=store.getWorkspace().snapshot.items[0].id;
 store.dispatchWorkspace({type:'save-template',id,name:'Copper deck'});
 store.dispatchWorkspace({type:'add-template',index:0,deck:'B'});
 store.dispatchWorkspace({type:'theme',id,value:'orchid'});
 assert.notEqual(store.getWorkspace().snapshot.items[1].design.theme,'orchid');
 store.dispatchWorkspace({type:'save-preset',name:'My setup'});
 store.dispatchWorkspace({type:'clear'});
 assert.equal(store.getWorkspace().snapshot.items.length,0);
 store.dispatchWorkspace({type:'load-preset',index:0});
 assert.equal(store.getWorkspace().snapshot.items.length,2);
 store.dispatchWorkspace({type:'undo'});
 assert.equal(store.getWorkspace().snapshot.items.length,0);
 store.dispatchWorkspace({type:'redo'});
 assert.equal(store.getWorkspace().snapshot.items.length,2);
 assert.deepEqual(store.get().decks,createStore(memory()).get().decks);
});

test('invalid designs are rejected atomically and failures remain visible across session writes',()=>{
 const storage=memory(),store=createStore(storage);
 assert.equal(typeof store.dispatchWorkspace,'function');
 store.dispatchWorkspace({type:'add',kind:'browser'});
 const before=structuredClone(store.getWorkspace());
 assert.throws(()=>store.dispatchWorkspace({type:'theme',id:before.snapshot.items[0].id,value:'url(https://example.invalid)'}),/theme/);
 assert.deepEqual(store.getWorkspace(),before);
 storage.setItem=()=>{throw Error('Quota');};
 store.dispatchWorkspace({type:'clear'});
 assert.match(store.getWarning(),/workspace.*not saved/i);
 storage.setItem=(key,value)=>storage.data.set(key,value);
 store.dispatch({type:'layout',value:'signal-one'});
 assert.match(store.getWarning(),/workspace.*not saved/i,'session writes cannot clear canvas save failures');
 store.dispatchWorkspace({type:'undo'});
 assert.equal(store.getWarning(),'');
});

test('one positioned palette drop is one save and one undo; history and capacities are bounded',()=>{
 let saves=0;const store=createStore({getItem:()=>null,setItem:()=>saves++});
 store.dispatchWorkspace({type:'add',kind:'deck',position:{x:80,y:120}});
 assert.equal(saves,1);assert.equal(store.getWorkspace().snapshot.items[0].x,80);
 store.dispatchWorkspace({type:'undo'});assert.equal(store.getWorkspace().snapshot.items.length,0);
 store.dispatchWorkspace({type:'redo'});
 const id=store.getWorkspace().snapshot.items[0].id;
 for(let i=0;i<60;i++)store.dispatchWorkspace({type:'theme',id,value:['ember','orchid','app','midnight'][i%4]});
 assert.equal(store.getWorkspaceHistory().undo,40);
 for(let i=1;i<24;i++)store.dispatchWorkspace({type:'add',kind:'crossfader'});
 const before=JSON.stringify(store.getWorkspace());
 assert.throws(()=>store.dispatchWorkspace({type:'add',kind:'deck'}),/maximum 24/);
 assert.equal(JSON.stringify(store.getWorkspace()),before);
});

test('unknown saved workspace preserves legacy session, original saved bytes and unrelated keys',()=>{
 const storage=memory(),first=createStore(storage);
 first.dispatch({type:'deck',deck:'D',field:'position',value:123});
 const text='{"version":99,"secret":"invalid synthetic fixture"}';
 storage.setItem(WORKSPACE_KEY,text);storage.setItem('unrelated','keep');
 const restored=createStore(storage);assert.equal(restored.get().decks.D.position,123);
 assert.equal(restored.getWorkspace().snapshot.items.length,0);assert.match(restored.getWarning(),/could not be restored/);
 restored.dispatch({type:'layout',value:'signal-wide'});
 assert.equal(storage.getItem(WORKSPACE_KEY),text);assert.equal(storage.getItem('unrelated'),'keep');
});
