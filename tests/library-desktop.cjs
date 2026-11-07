"use strict";
const assert = require("node:assert/strict");
// Real Electron bridge/native registry checks. The table-only baseline deliberately removed its
// import/collection toolbar; exercise retained semantic IPC, not fabricated replacement controls.
module.exports = async function ({js, command, until, checks, idA, phase, expected}) {
  const read = () => command({type:"library"});
  const call = async request => { const result=await command(request); assert.equal(result.ok,true,JSON.stringify(result)); return result; };
  if (phase === "restore") {
    const library = await read();
    assert.deepEqual(library.collections,expected.collections);assert.equal(library.tracks.length,2);
    assert.equal(await js("document.querySelectorAll('.local-library tr[data-track-id]:not([hidden])').length"),2);
    assert.equal(await js("document.querySelectorAll('[data-action=library-view]').length"),0);
    checks.push("Actual native library, named crate and ordered playlist survive restart; table shows all tracks without retired filter controls");
    return;
  }
  await js("document.querySelector('section[data-deck=A] [data-field=playing]').click()");
  await until(async()=>(await command({type:"status"})).snapshot.decks[0].playing,"play before library import");
  const start=(await command({type:"status"})).snapshot;
  let result=await call({type:"import",kind:"files"});assert.equal(result.tracks.length,2);
  assert.ok(!JSON.stringify(result).includes('"path"'));
  let now=(await command({type:"status"})).snapshot;
  assert.equal(now.decks[0].trackId,start.decks[0].trackId);assert.equal(now.decks[0].loadGeneration,start.decks[0].loadGeneration);assert.equal(now.decks[0].playing,true);
  checks.push("Files import through actual native inspection/IPC while the loaded deck keeps playing unchanged");
  result=await call({type:"import",kind:"folder"});assert.equal(result.tracks.length,2);assert.equal(result.summary.failed,1);assert.ok(result.summary.existing>=1);
  now=(await command({type:"status"})).snapshot;assert.equal(now.decks[0].playing,true);assert.equal(now.decks[0].loadGeneration,start.decks[0].loadGeneration);
  await js("document.querySelector('section[data-deck=A] [data-field=playing]').click()");
  await until(async()=>!(await command({type:"status"})).snapshot.decks[0].playing,"pause after import");
  checks.push("Recursive folder import deduplicates originals and reports the real corrupt fixture through the bridge without interrupting audio");
  const ids=(await read()).tracks.map(t=>t.id),idB=ids.find(id=>id!==idA);
  const crate=(await call({type:"collection-create",kind:"crate",name:"Warm up <safe>"})).collection;
  await call({type:"collection-add",id:crate.id,trackIds:ids});
  await call({type:"collection-rename",id:crate.id,name:"Opening crate"});
  const playlist=(await call({type:"collection-create",kind:"playlist",name:"Practice set"})).collection;
  await call({type:"collection-add",id:playlist.id,trackIds:ids});
  await call({type:"collection-move",id:playlist.id,trackId:ids[1],direction:-1});
  assert.deepEqual((await read()).collections.find(c=>c.id===playlist.id).trackIds,[ids[1],ids[0]]);
  await call({type:"collection-remove",id:playlist.id,trackIds:[idB]});
  assert.equal((await read()).collections.find(c=>c.id===playlist.id).trackIds.length,1);
  await call({type:"collection-add",id:playlist.id,trackIds:[idB]});
  const temporary=(await call({type:"collection-create",kind:"crate",name:"Delete this collection"})).collection;
  await call({type:"collection-delete",id:temporary.id});
  const library=await read();assert.equal(library.tracks.length,2);assert.ok(!library.collections.some(c=>c.id===temporary.id));
  assert.equal((await command({type:"forget",trackIds:[idA]})).error,"track_in_use");
  checks.push("Real semantic IPC creates/renames/deletes crates, edits/reorders playlist membership and rejects forgetting the loaded source; original tracks remain");
  // Refresh the real renderer catalog using its ordinary restore path. Also seed inaccessible old
  // filters: the table-only view must still project the complete library and keep the saved data.
  await js(`{const s=JSON.parse(localStorage.getItem('deck-craft.ui.v1'));s.library.crate=${JSON.stringify(playlist.id)};s.library.sort='order';s.library.query='nonmatching retained query';localStorage.setItem('deck-craft.ui.v1',JSON.stringify(s));}`);
  await js("location.reload();void 0;");
  await until(()=>js("!!document.querySelector('.native-import')&&!document.querySelector('.native-import').disabled"),"table renderer restored");
  for(const mode of ["perform","prepare"]) {
    await js(`document.querySelector('[data-action="mode"][data-value="${mode}"]').click()`);
    assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"),true);
    const table=await js("(()=>{const p=document.querySelector('.local-library'),wrap=p.querySelector('.table-wrap').getBoundingClientRect(),rows=[...p.querySelectorAll('tr[data-track-id]:not([hidden])')],buttons=rows.map(r=>r.querySelector('.load'));return {rows:rows.length,controls:p.querySelectorAll('[data-action=library-view],[data-action=library-import]').length,fit:buttons.length===2&&buttons.every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=wrap.left&&r.right<=wrap.right+1;})};})()");
    assert.deepEqual(table,{rows:2,controls:0,fit:true},mode);
  }
  const saved=await js("JSON.parse(localStorage.getItem('deck-craft.ui.v1')).library");assert.equal(saved.crate,playlist.id);assert.equal(saved.query,"nonmatching retained query");
  checks.push("Perform and Library show both real-native tracks and contained row-load controls despite retained hidden filters; stored collection/query preferences are unchanged");
  return {collections:(await read()).collections,playlistId:playlist.id};
};
