import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { COMPONENT_KINDS, createComponent, validateComponent, parseDesign, creatorKit, workspaceStarter, validateWorkspace } from '../src/workspace.js';
import { LAYOUTS, registerLocalTrack } from '../src/catalog.js';
import { createSession, reduceSession } from '../src/session.js';
import { renderCanvasContent } from '../src/canvas-view.js';
import { renderDesignPreview } from '../src/canvas-editor.js';
import { NativeSession } from '../src/native.js';

test('all kinds round-trip; strict unknown fields, markup, URLs, bounds and versions fail closed',()=>{
 for(const kind of COMPONENT_KINDS)assert.deepEqual(parseDesign(JSON.stringify(createComponent(kind))),createComponent(kind));
 for(const [field,value] of [['version',2],['kind','processor'],['script','alert(1)'],['path','private-track.wav']]){
  const valueWithBadField={...createComponent(),[field]:value};assert.throws(()=>validateComponent(valueWithBadField));
 }
 for(const [field,value] of [['surface','url(https://example.invalid)'],['accent','red;display:none'],['radius',100],['fontScale',0],['density','invisible']]){
  const component=createComponent();component.style[field]=value;assert.throws(()=>validateComponent(component));
 }
 assert.throws(()=>parseDesign(' '.repeat(262145)),/256 KiB/);
 assert.throws(()=>parseDesign('{bad'),/JSON/);
 const component=createComponent();component.name='<img onerror=alert(1)>';assert.equal(validateComponent(component).name,component.name,'names are plain escaped text, not executable markup');
});

test('all five starter canvases use valid designs and no musical session fields',()=>{
 for(const layout of LAYOUTS){const starter=workspaceStarter(layout.id);assert.deepEqual(validateWorkspace(starter),starter);assert.equal(starter.items.filter(i=>i.design.kind==='deck').length,layout.decks);assert.ok(!JSON.stringify(starter).includes('trackId'));}
 const starter=workspaceStarter('signal-one');starter.items.push(structuredClone(starter.items[0]));assert.throws(()=>validateWorkspace(starter),/duplicate/);
});

test('component accents reach waveform rendering without rewriting track metadata',()=>{
 const local=registerLocalTrack({id:'local-11111111-1111-1111-1111-111111111111',title:'Literal #b5d98a fixture.wav',duration:30,peaks:[]});
 const state=reduceSession(createSession(),{type:'load',deck:'A',trackId:local.id}),design=createComponent();design.style.accent='#cc9966';
 const markup=renderCanvasContent(design,state);assert.match(markup,/stop-color="#cc9966"/);assert.ok(markup.includes(local.title));
});

test('creator deck previews cannot enter native transport painting',()=>{
 const markup=renderDesignPreview(createComponent('deck'));
 const previous=globalThis.document;
 globalThis.document={body:{classList:{add(){}}},querySelector:selector=>selector==='.app'?{}:selector==='.native-audio-bar'?{querySelector:()=>({})}:null,querySelectorAll:selector=>selector==='[data-field="playing"]'&&markup.includes('data-field="playing"')?[{dataset:{},setAttribute(){}}]:[]};
 try {
  assert.doesNotThrow(()=>NativeSession.prototype.paint.call({store:{get:createSession},status:{ready:false,decks:[]},busy:new Set(),initialized:true,paintClock:NativeSession.prototype.paintClock}));
  assert.doesNotMatch(markup,/ data-(?:action|field|deck|wave-deck|track-id)=/);
 } finally {if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test('native browser previews contain synthetic fixtures, not private catalog entries',()=>{
 const local=registerLocalTrack({id:'local-22222222-2222-2222-2222-222222222222',title:'Private preview exclusion fixture.wav',duration:30,peaks:[]});
 const previous=globalThis.deckCraftNative;globalThis.deckCraftNative={};
 try {
  const markup=renderDesignPreview(createComponent('browser'));
  assert.ok(!markup.includes(local.title));assert.ok(!markup.includes(local.id));
  assert.match(markup,/Synthetic sleeve/);assert.doesNotMatch(markup,/ data-(?:action|field|deck|wave-deck|track-id)=/);
 } finally {if(previous===undefined)delete globalThis.deckCraftNative;else globalThis.deckCraftNative=previous;}
});

test('offline exported agent validator executes and agrees with app validation',async()=>{
 const parent=process.env.TMPDIR||path.resolve('release/test-scratch');await mkdir(parent,{recursive:true});
 const folder=await mkdtemp(path.join(parent,'deckcraft-kit-'));
 try {
  const kit=creatorKit(createComponent('mixer'));
  for(const [name,content] of Object.entries(kit.files))await writeFile(path.join(folder,name),content);
  const run=()=>spawnSync(process.execPath,['validate.mjs','component.json'],{cwd:folder,encoding:'utf8'});
  const accepted=run();assert.equal(accepted.status,0,accepted.stderr);assert.equal(JSON.parse(accepted.stdout).ok,true);
  const invalid=createComponent();invalid.style.radius=-1;await writeFile(path.join(folder,'component.json'),JSON.stringify(invalid));
  const rejected=run();assert.equal(rejected.status,1);assert.match(rejected.stderr,/radius/);
  const text=JSON.stringify(kit);assert.ok(!text.includes('trackId'));assert.ok(!text.includes('peaks'));assert.match(kit.files['AGENTS.md'],/Styling only/);
 } finally {await rm(folder,{recursive:true,force:true});}
});
