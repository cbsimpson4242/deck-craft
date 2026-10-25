import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore,STORAGE_KEY} from '../src/store.js';
const memoryStorage=()=>{const data=new Map();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),data};};

test('device choice survives a new store with the same storage',()=>{
 const storage=memoryStorage();const first=createStore(storage);
 first.dispatch({type:'layout',value:'signal-wide'});
 first.dispatch({type:'deck',deck:'C',field:'position',value:111.1});
 first.dispatch({type:'deck',deck:'C',field:'playing',value:true});
 assert.ok(storage.getItem(STORAGE_KEY),'a durable snapshot was written');
 const second=createStore(storage);assert.equal(second.get().layout,'signal-wide');assert.equal(second.get().decks.C.position,111.1);assert.equal(second.get().decks.C.playing,false);
});

test('storage refusal retains in-memory state and surfaces a warning',()=>{
 const store=createStore({getItem:()=>null,setItem:()=>{throw new Error('Quota');}});
 store.dispatch({type:'layout',value:'studio-linear'});
 assert.equal(store.get().layout,'studio-linear');assert.match(store.getWarning(),/not saved/i);
});

test('blocked reads and malformed snapshots recover without clearing unrelated keys',()=>{
 const unavailable=createStore({getItem:()=>{throw new Error('Denied');},setItem:()=>{throw new Error('Denied');}});assert.equal(unavailable.get().layout,'studio-sync');assert.match(unavailable.getWarning(),/not saved/i);
 const storage=memoryStorage();storage.setItem(STORAGE_KEY,'{broken');storage.setItem('other-app','preserve');const store=createStore(storage);assert.match(store.getWarning(),/recover/i);store.dispatch({type:'layout',value:'signal-one'});assert.equal(storage.getItem('other-app'),'preserve');
});

test('one admitted state change has one save owner and unsubscribe is effective',()=>{
 let saves=0,calls=0;const store=createStore({getItem:()=>null,setItem:()=>{saves++;}});const off=store.subscribe(()=>calls++);
 store.dispatch({type:'layout',value:'signal-one'});assert.equal(saves,1);assert.equal(calls,1);off();store.dispatch({type:'layout',value:'studio-grid'});assert.equal(saves,2);assert.equal(calls,1);
});
