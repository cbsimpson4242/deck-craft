import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,symlink,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {LocalLibrary}=require('../desktop/library.cjs');
const {importSelection}=require('../desktop/importer.cjs');
// The decoder is mocked here; actual binary inspection is exercised by the
// Electron/native lane. The filesystem, dedupe and persistence below are real.
test('folder import is recursive, bounded, deduplicated, symlink-safe and keeps failures private',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'deckcraft-import-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(path.join(dir,'music/nested'),{recursive:true});
 for(const name of ['One.wav','nested/Two.MP3','broken.wav','notes.txt'])await writeFile(path.join(dir,'music',name),'generated');
 await symlink(path.join(dir,'music'),path.join(dir,'music/nested/cycle'));
 const library=new LocalLibrary(path.join(dir,'private'));let calls=0;const progress=[];
 const inspect=async r=>{calls++;if(r.path.endsWith('broken.wav'))throw Error('unsupported_or_corrupt_audio');return {duration:30,channels:2,sampleRate:48000};};
 const first=await importSelection(library,[path.join(dir,'music')],{folder:true,inspect,progress:e=>progress.push(e)});
 assert.equal(first.summary.added,2);assert.equal(first.summary.failed,1);assert.equal(first.summary.skipped,2);
 assert.equal(first.summary.errors[0].name,'broken.wav');assert.ok(!JSON.stringify(first).includes(dir));
 assert.equal(progress.at(-1).completed,3);assert.equal(library.records.size,2);
 const second=await importSelection(library,[path.join(dir,'music/One.wav')],{inspect});
 assert.equal(second.summary.existing,1);assert.equal(calls,3);
 const restored=new LocalLibrary(library.directory);await restored.restore();assert.equal(restored.list().length,2);
 assert.equal(await readFile(path.join(dir,'music/One.wav'),'utf8'),'generated');
});
