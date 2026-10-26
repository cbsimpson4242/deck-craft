import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {LocalLibrary}=require('../desktop/library.cjs');
const {validateIPC}=require('../desktop/policy.cjs');
async function fixture(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'deckcraft-collections-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const library=new LocalLibrary(path.join(dir,'private'));
  const ids=[];
  for(const name of ['First.wav','Second.wav']) {
    const filename=path.join(dir,name);await writeFile(filename,'generated fixture');
    const r=await library.select(filename);library.commit(r.id,{duration:30,channels:2,sampleRate:48000});ids.push(r.id);
  }
  await library.save();return {library,ids,dir};
}
test('crates and ordered playlists persist without publishing source paths or deleting music',async t=>{
  const {library,ids,dir}=await fixture(t);
  const crate=await library.changeCollection({type:'collection-create',kind:'crate',name:'Warm up'});
  const playlist=await library.changeCollection({type:'collection-create',kind:'playlist',name:'Set <one>'});
  await library.changeCollection({type:'collection-add',id:crate.id,trackIds:ids});
  await library.changeCollection({type:'collection-add',id:playlist.id,trackIds:[ids[1],ids[0]]});
  await library.changeCollection({type:'collection-add',id:playlist.id,trackIds:[ids[1]]});
  await library.changeCollection({type:'collection-move',id:playlist.id,trackId:ids[0],direction:-1});
  await library.changeCollection({type:'collection-rename',id:crate.id,name:'Opening'});
  const restored=new LocalLibrary(library.directory);await restored.restore();
  assert.equal(restored.warning,'');assert.deepEqual(restored.collections.find(c=>c.id===playlist.id).trackIds,ids);
  assert.equal(restored.collections.find(c=>c.id===crate.id).name,'Opening');
  assert.ok(!JSON.stringify(restored.collections).includes(dir));
  await restored.changeCollection({type:'collection-remove',id:crate.id,trackIds:[ids[0]]});
  await restored.changeCollection({type:'collection-delete',id:playlist.id});
  await restored.forget([ids[1]]);
  assert.equal(await readFile(path.join(dir,'Second.wav'),'utf8'),'generated fixture');
  const reopened=new LocalLibrary(library.directory);await reopened.restore();
  assert.deepEqual(reopened.list().map(t=>t.id),[ids[0]]);
  assert.deepEqual(reopened.collections[0].trackIds,[]);
});
test('collection failures preserve durable state and reject unknown references',async t=>{
  const {library,ids}=await fixture(t);
  const c=await library.changeCollection({type:'collection-create',kind:'crate',name:'Keep'});
  const before=await readFile(library.filename,'utf8');
  await assert.rejects(library.changeCollection({type:'collection-add',id:c.id,trackIds:['local-00000000-0000-0000-0000-000000000000']}));
  assert.equal(await readFile(library.filename,'utf8'),before);
  const old=library.writeSnapshot;library.writeSnapshot=async()=>false;
  await assert.rejects(library.changeCollection({type:'collection-rename',id:c.id,name:'Unsaved'}),/library_save_failed/);
  assert.equal(library.collections[0].name,'Keep');
  await assert.rejects(library.forget(ids),/library_save_failed/);
  assert.equal(library.list().length,2);library.writeSnapshot=old;
});
test('new IPC is semantic, bounded and never accepts renderer file paths',()=>{
  for(const r of [
    {type:'import',kind:'files',path:'/private/music'},
    {type:'import',kind:'arbitrary'},
    {type:'collection-create',kind:'crate',name:' '},
    {type:'collection-add',id:'../../file',trackIds:[]},
    {type:'collection-move',id:'collection-00000000-0000-0000-0000-000000000000',trackId:'local-00000000-0000-0000-0000-000000000000',direction:99},
    {type:'forget',trackIds:Array(1001).fill('local-00000000-0000-0000-0000-000000000000')},
  ])assert.throws(()=>validateIPC(r));
  assert.deepEqual(validateIPC({type:'import',kind:'folder'}),{type:'import',kind:'folder'});
  assert.equal(validateIPC({type:'collection-create',kind:'playlist',name:'Set'}).name,'Set');
});
