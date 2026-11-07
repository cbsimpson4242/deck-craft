import test from 'node:test';
import assert from 'node:assert/strict';
import {replaceLocalLibrary,libraryCollections} from '../src/catalog.js';
import {nativeLibrary,orderedLibraryTracks} from '../src/library.js';
import {createSession,reduceSession,restoreSession,serializeSession} from '../src/session.js';
const a='local-00000000-0000-0000-0000-000000000001',b='local-00000000-0000-0000-0000-000000000002';
const collection='collection-00000000-0000-0000-0000-000000000001';
test('native library defaults to real files, supports search, sort and saved playlist order',()=>{
 replaceLocalLibrary([{id:a,title:'Zed.wav',duration:10},{id:b,title:'Alpha.wav',duration:20}],[{id:collection,name:'Set',kind:'playlist',trackIds:[a,b]}]);
 let state=createSession();assert.deepEqual(orderedLibraryTracks(state).map(t=>t.id),[b,a]);
 state=reduceSession(state,{type:'library',field:'sort',value:'duration'});assert.deepEqual(orderedLibraryTracks(state).map(t=>t.id),[a,b]);
 state=reduceSession(state,{type:'library',field:'crate',value:collection});
 state=reduceSession(state,{type:'library',field:'sort',value:'order'});assert.deepEqual(orderedLibraryTracks(state).map(t=>t.id),[a,b]);
 state=restoreSession(serializeSession(state)).state;assert.equal(state.library.crate,collection);assert.equal(state.library.sort,'order');
 state=reduceSession(state,{type:'library',field:'query',value:'alpha'});assert.deepEqual(orderedLibraryTracks(state).map(t=>t.id),[b]);
});
test('native library escapes local basenames and collection names; empty imports expose no demo music as playable',()=>{
 replaceLocalLibrary([{id:a,title:'<img src=x onerror=alert(1)>.wav',duration:10}],[{id:collection,name:'<script>unsafe</script>',kind:'crate',trackIds:[a]}]);
 const html=nativeLibrary(createSession());assert.ok(!html.includes('<img src=x'));assert.ok(!html.includes('<script>unsafe'));
 assert.match(html,/&lt;img/);assert.ok(!html.includes('<script>'));
 replaceLocalLibrary([],[]);assert.equal(orderedLibraryTracks(createSession()).length,0);
 assert.match(nativeLibrary(createSession()),/No local tracks in the library/);
});

test('table-only library ignores inaccessible restored filters without changing saved data',()=>{
 replaceLocalLibrary([{id:a,title:'Zed.wav',duration:10},{id:b,title:'Alpha.wav',duration:20}],[{id:collection,name:'Saved set',kind:'playlist',trackIds:[a]}]);
 let state=createSession();
 for(const [field,value] of [['crate',collection],['query','no match'],['sort','order']])state=reduceSession(state,{type:'library',field,value});
 const before=serializeSession(state);
 assert.deepEqual(orderedLibraryTracks(state,{unfiltered:true}).map(t=>t.id),[b,a]);
 assert.equal(serializeSession(state),before);
 assert.deepEqual(libraryCollections().find(c=>c.id===collection).trackIds,[a]);
 state=reduceSession(state,{type:'library',field:'crate',value:'demo'});
 assert.deepEqual(orderedLibraryTracks(state,{unfiltered:true}).map(t=>t.id),[b,a]);
 const html=nativeLibrary(state);
 for(const name of ['library-toolbar','library-imports','library-navigation','library-selection','load-choice','data-action="search"','data-action="density"','data-action="library-view"'])assert.ok(!html.includes(name),name);
 assert.ok(html.indexOf('class="table-wrap"')<html.indexOf('class="library-feedback"'));
 assert.match(html,/role="status" aria-live="polite"><\/div>/);
});
