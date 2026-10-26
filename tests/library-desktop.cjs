"use strict";
const assert=require('node:assert/strict');
// Runs inside the real Electron/native harness. Only OS selection is injected.
module.exports=async function checkLibrary({js,command,until,checks,idA,phase,expected}) {
 const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const change=(selector,value)=>js(`{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));}`);
 const read=()=>command({type:'library'});
 const create=async(kind,name)=>{
   await click(`[data-action="library-new"][data-kind="${kind}"]`);
   await js(`document.querySelector('.collection-name').value=${JSON.stringify(name)}`);
   await click('[data-action="library-save"]');
   await until(async()=>(await read()).collections.some(c=>c.name===name),'saved '+kind);
   await until(()=>js("!document.querySelector('[data-action=library-new]').disabled"),'collection UI settled');
   return (await read()).collections.find(c=>c.name===name);
 };
 if(phase==='restore') {
   const library=await read();
   assert.deepEqual(library.collections,expected.collections);
   assert.equal(library.tracks.length,2);
   assert.equal(await js("document.querySelector('[data-action=library-view]').value"),expected.playlistId);
   checks.push('Native library, named crate, ordered playlist and selected collection survive a full app restart');
   return;
 }
 await click('section[data-deck="A"] [data-field="playing"]');
 await until(async()=>(await command({type:'status'})).snapshot.decks[0].playing,'play before library import');
 const start=(await command({type:'status'})).snapshot;
 await click('[data-action="library-import"][data-kind="files"]');
 await until(async()=>(await read()).tracks.length===2,'multiple selected files inspected by actual native decoder');
 await until(()=>js("!document.querySelector('[data-action=library-import]').disabled"),'file import UI settled');
 let library=await read();
 assert.ok(!JSON.stringify(library).includes('"path"'));
 const idB=library.tracks.find(t=>t.id!==idA).id;
 let now=(await command({type:'status'})).snapshot;
 assert.equal(now.decks[0].trackId,start.decks[0].trackId);assert.equal(now.decks[0].loadGeneration,start.decks[0].loadGeneration);
 assert.equal(now.decks[0].playing,true);
 checks.push('Add files uses real native metadata inspection without changing any deck');
 await click('[data-action="library-import"][data-kind="folder"]');
 await until(()=>js("document.querySelector('.library-feedback').textContent.includes('1 failed')"),'new recursive folder import summary, not the previous files-import receipt');
 await until(()=>js("!document.querySelector('[data-action=library-import]').disabled"),'folder import complete');
 library=await read();assert.equal(library.tracks.length,2);
 assert.match(await js("document.querySelector('.library-feedback').textContent"),/1 failed/);
 now=(await command({type:'status'})).snapshot;
 assert.equal(now.decks[0].playing,true);assert.equal(now.decks[0].loadGeneration,start.decks[0].loadGeneration);
 await click('section[data-deck="A"] [data-field="playing"]');
 await until(async()=>!(await command({type:'status'})).snapshot.decks[0].playing,'pause after import');
 checks.push('Recursive folder import deduplicates existing sources and reports a real corrupt fixture without publishing paths');
 await js("{const s=document.querySelector('.search');s.value='Second';s.dispatchEvent(new Event('input',{bubbles:true}));}");
 assert.equal(await js("document.querySelectorAll('tr[data-track-id]:not([hidden])').length"),1);
 await click('[data-action="library-select-all"]');
 assert.equal(await js("document.querySelector('.library-selected-count').textContent"),'1 selected');
 await js("{const s=document.querySelector('.search');s.value='';s.dispatchEvent(new Event('input',{bubbles:true}));}");
 checks.push('Search and select-visible act on the real imported library, not synthetic demo rows');
 const crate=await create('crate','Warm up <safe>');
 await change('[data-action="library-view"]','all');
 await click('[data-action="library-select-all"]');
 await change('[data-action="library-destination"]',crate.id);
 await click('[data-action="library-add"]');
 await until(async()=>(await read()).collections.find(c=>c.id===crate.id).trackIds.length===2,'crate membership saved');
 await until(()=>js("!document.querySelector('[data-action=library-new]').disabled"),'crate add settled');
 await change('[data-action="library-view"]',crate.id);
 await click('[data-action="library-rename"]');
 await js("document.querySelector('.collection-name').value='Opening crate'");await click('[data-action="library-save"]');
 await until(async()=>(await read()).collections.find(c=>c.id===crate.id).name==='Opening crate','crate renamed');
 await until(()=>js("!document.querySelector('[data-action=library-new]').disabled"),'rename settled');
 const playlist=await create('playlist','Practice set');
 await change('[data-action="library-destination"]',playlist.id);await click('[data-action="library-add"]');
 await until(async()=>(await read()).collections.find(c=>c.id===playlist.id).trackIds.length===2,'playlist saved');
 await until(()=>js("!document.querySelector('[data-action=library-new]').disabled"),'playlist add settled');
 const initial=(await read()).collections.find(c=>c.id===playlist.id).trackIds;
 await click(`[data-action="library-move"][data-track="${initial[1]}"][data-direction="-1"]`);
 await until(async()=>(await read()).collections.find(c=>c.id===playlist.id).trackIds[0]===initial[1],'playlist reordered');
 await until(()=>js("!document.querySelector('[data-action=library-new]').disabled"),'reorder settled');
 assert.equal(await js("document.querySelectorAll('.local-library img').length"),0);
 checks.push('Actual desktop controls create, populate and rename a crate, create a playlist and persist its changed order');
 // Remove membership through UI, then add it back; never remove a music file.
 await click('[data-action="library-select-all"]'); // clears the existing selection
 await click(`[data-action="library-select"][data-track="${idB}"]`);
 await click('[data-action="library-remove"]');
 await until(async()=>(await read()).collections.find(c=>c.id===playlist.id).trackIds.length===1,'membership removed');
 await until(()=>js("!document.querySelector('[data-action=library-new]').disabled"),'remove settled');
 await click('[data-action="library-add"]');
 await until(async()=>(await read()).collections.find(c=>c.id===playlist.id).trackIds.length===2,'membership restored');
 await until(()=>js("!document.querySelector('[data-action=library-new]').disabled"),'restore membership settled');
 const temporary=await create('crate','Delete this collection');await click('[data-action="library-delete"]');await click('[data-action="library-save"]');
 await until(async()=>!(await read()).collections.some(c=>c.id===temporary.id),'collection deleted');
 await until(()=>js("!document.querySelector('[data-action=library-new]').disabled"),'delete settled');
 assert.equal((await read()).tracks.length,2);
 assert.equal((await command({type:'forget',trackIds:[idA]})).error,'track_in_use');
 checks.push('Removing membership or deleting a collection retains source tracks; removing a loaded track from the library is rejected');
 await change('[data-action="library-view"]',playlist.id);
 await change('[data-action="library-sort"]','order');
 // Every layout retains the collection and reaches the same native library.
 for(const layout of ['signal-one','signal-wide','studio-grid','studio-linear','studio-sync']) {
   await change('.layout-picker',layout);
   assert.equal(await js("document.querySelector('[data-action=library-view]').value"),playlist.id);
   assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"),true);
   assert.equal(await js("(()=>{const wrap=document.querySelector('.local-library .table-wrap').getBoundingClientRect(),buttons=[...document.querySelectorAll('tr:not([hidden]) .load-cell button')].filter(e=>e.getClientRects().length);return buttons.length===6&&buttons.every(e=>{const r=e.getBoundingClientRect();return r.left>=wrap.left&&r.right<=wrap.right+1;});})()"),true,'load/order controls must fit the visible library viewport in '+layout);
 }
 checks.push('All five native layouts retain the same selected playlist without horizontal page overflow');
 return {collections:(await read()).collections,playlistId:playlist.id};
};
