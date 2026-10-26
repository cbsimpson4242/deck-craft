import { DECK_IDS, LAYOUTS } from './catalog.js';

// The same schema and validator are shipped in the offline agent creator kit.
export const COMPONENT_KINDS=['deck','mixer','browser','waveform','cues','crossfader','effects'];
export const DESIGN_LIMIT=262144;
const wsColor={type:'string',minLength:7,maxLength:7,pattern:'^#[0-9a-fA-F]{6}$'};
const wsText={type:'string',minLength:1,maxLength:64};
const wsInteger=(minimum,maximum)=>({type:'integer',minimum,maximum});
const wsObject=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
export const COMPONENT_SCHEMA=wsObject({
 format:{const:'deckcraft.component'},version:{const:1},name:wsText,kind:{enum:COMPONENT_KINDS},deck:{enum:DECK_IDS},
 style:wsObject({accent:wsColor,surface:wsColor,text:wsColor,radius:wsInteger(0,24),density:{enum:['compact','comfortable']},fontScale:wsInteger(90,120)}),
 parts:wsObject({waveform:{type:'boolean'},cues:{type:'boolean'},artwork:{type:'boolean'}})
});
const wsItemSchema=wsObject({id:{type:'string',pattern:'^item-[0-9]+$(?![\\s\\S])',maxLength:24},design:COMPONENT_SCHEMA,x:wsInteger(0,2400),y:wsInteger(0,4800),width:wsInteger(320,1600),height:wsInteger(160,1600)});
export const WORKSPACE_SCHEMA=wsObject({format:{const:'deckcraft.workspace'},version:{const:1},name:wsText,snap:{type:'boolean'},items:{type:'array',maxItems:24,items:wsItemSchema}});
const wsStorageSchema=wsObject({version:{const:1},active:{type:'boolean'},snapshot:WORKSPACE_SCHEMA,templates:{type:'array',maxItems:24,items:COMPONENT_SCHEMA},presets:{type:'array',maxItems:8,items:WORKSPACE_SCHEMA}});

/** Deliberately small JSON Schema subset; no executable markup, CSS, URLs or native commands. */
export function validateDesignSchema(value,schema,path='$') {
 const fail=message=>{throw Error(path+': '+message);};
 if(Object.hasOwn(schema,'const')&&value!==schema.const)fail('expected '+JSON.stringify(schema.const));
 if(schema.enum&&!schema.enum.includes(value))fail('expected one of '+schema.enum.join(', '));
 if(schema.type==='object') {
  if(!value||typeof value!=='object'||Array.isArray(value))fail('expected object');
  for(const key of Object.keys(value))if(!Object.hasOwn(schema.properties,key))fail('unknown field '+key);
  for(const key of schema.required)if(!Object.hasOwn(value,key))fail('missing '+key);
  for(const [key,child] of Object.entries(schema.properties))validateDesignSchema(value[key],child,path+'.'+key);
 } else if(schema.type==='array') {
  if(!Array.isArray(value))fail('expected array');
  if(value.length>schema.maxItems)fail('too many entries; maximum '+schema.maxItems);
  value.forEach((item,index)=>validateDesignSchema(item,schema.items,path+'['+index+']'));
 } else if(schema.type==='string') {
  if(typeof value!=='string')fail('expected string');
  const length=[...value].length;
  if(length<(schema.minLength||0)||length>(schema.maxLength||Infinity))fail('invalid length');
  if(schema.pattern&&!new RegExp(schema.pattern).test(value))fail('invalid format');
 } else if(schema.type==='integer') {
  if(!Number.isInteger(value)||value<schema.minimum||value>schema.maximum)fail('expected integer '+schema.minimum+'..'+schema.maximum);
 } else if(schema.type==='boolean'&&typeof value!=='boolean')fail('expected boolean');
 return value;
}
export function validateComponent(value) {validateDesignSchema(value,COMPONENT_SCHEMA);return structuredClone(value);}
export function validateWorkspace(value) {
 validateDesignSchema(value,WORKSPACE_SCHEMA);
 if(new Set(value.items.map(item=>item.id)).size!==value.items.length)throw Error('$.items: duplicate item IDs');
 return structuredClone(value);
}
export function parseDesign(text) {
 if(typeof text!=='string'||new TextEncoder().encode(text).length>DESIGN_LIMIT)throw Error('$: design exceeds 256 KiB');
 let value;try{value=JSON.parse(text);}catch{throw Error('$: invalid JSON');}
 if(value?.format==='deckcraft.component')return validateComponent(value);
 if(value?.format==='deckcraft.workspace')return validateWorkspace(value);
 throw Error('$.format: expected deckcraft.component or deckcraft.workspace');
}
export function createComponent(kind='deck',deckId='A') {
 return validateComponent({format:'deckcraft.component',version:1,name:kind==='browser'?'Collection':kind[0].toUpperCase()+kind.slice(1),kind,deck:deckId,style:{accent:'#b5d98a',surface:'#18232d',text:'#dce8ef',radius:10,density:'comfortable',fontScale:100},parts:{waveform:true,cues:true,artwork:true}});
}
export function createWorkspace() {return {version:1,active:false,snapshot:{format:'deckcraft.workspace',version:1,name:'My workspace',snap:true,items:[]},templates:[],presets:[]};}
export function restoreWorkspace(text) {
 if(!text)return createWorkspace();
 if(typeof text!=='string'||text.length>1048576)throw Error('Saved workspace is too large');
 const value=JSON.parse(text);validateDesignSchema(value,wsStorageSchema);validateWorkspace(value.snapshot);value.presets.forEach(validateWorkspace);
 return structuredClone(value);
}
const wsSizes={deck:[560,400],mixer:[540,600],browser:[780,520],waveform:[560,180],cues:[420,180],crossfader:[420,160],effects:[660,180]};
function appendDesign(snapshot,design) {
 const index=snapshot.items.length;let next=1;
 while(snapshot.items.some(item=>item.id==='item-'+next))next++;
 const [width,height]=wsSizes[design.kind];
 snapshot.items.push({id:'item-'+next,design:structuredClone(design),x:index%3*820,y:Math.floor(index/3)*660,width,height});
}
export function workspaceStarter(layoutId) {
 if(!LAYOUTS.some(layout=>layout.id===layoutId))throw Error('Unknown starter preset');
 const snapshot=createWorkspace().snapshot;snapshot.name=LAYOUTS.find(layout=>layout.id===layoutId).name+' canvas';
 const two=layoutId.startsWith('signal'),linear=layoutId==='studio-linear';
 const ids=two?['A','B']:DECK_IDS;
 ids.forEach((id,i)=>{appendDesign(snapshot,createComponent('deck',id));const item=snapshot.items.at(-1);item.x=linear?0:i%2*580;item.y=linear?i*420:Math.floor(i/2)*420;item.width=560;});
 appendDesign(snapshot,createComponent('mixer'));Object.assign(snapshot.items.at(-1),{x:1160,y:0,width:520,height:680});
 appendDesign(snapshot,createComponent('browser'));Object.assign(snapshot.items.at(-1),{x:linear?580:0,y:linear?720:two?440:860,width:1120,height:480});
 if(layoutId==='studio-sync'){appendDesign(snapshot,createComponent('waveform'));Object.assign(snapshot.items.at(-1),{x:1160,y:700,width:520,height:180});}
 return validateWorkspace(snapshot);
}
/** Pure presentation transitions. Never contains or changes track IDs, transport, or music. */
export function reduceWorkspace(state,action) {
 const next=structuredClone(state),snapshot=next.snapshot,item=snapshot.items.find(entry=>entry.id===action.id);
 switch(action.type) {
  case 'active':next.active=action.value;break;
  case 'add':appendDesign(snapshot,createComponent(action.kind,action.deck||'A'));if(action.position)Object.assign(snapshot.items.at(-1),action.position);break;
  case 'add-template':{const design=next.templates[action.index];if(!design)throw Error('Unknown template');appendDesign(snapshot,{...design,deck:action.deck||design.deck});break;}
  case 'remove':snapshot.items=snapshot.items.filter(entry=>entry.id!==action.id);break;
  case 'item':if(!item)throw Error('Select a component');Object.assign(item,action.patch);break;
  case 'style':if(!item)throw Error('Select a component');Object.assign(item.design.style,action.patch);break;
  case 'parts':if(!item)throw Error('Select a component');Object.assign(item.design.parts,action.patch);break;
  case 'design':if(!item)throw Error('Select a component');item.design=validateComponent({...item.design,...action.patch});break;
  case 'name':snapshot.name=action.value;break;
  case 'snap':snapshot.snap=action.value;break;
  case 'clear':snapshot.items=[];break;
  case 'starter':next.snapshot=workspaceStarter(action.value);break;
  case 'save-template':if(!item)throw Error('Select a component');next.templates.push({...structuredClone(item.design),name:action.name});break;
  case 'delete-template':next.templates.splice(action.index,1);break;
  case 'save-preset':next.presets.push({...structuredClone(snapshot),name:action.name});break;
  case 'load-preset':if(!next.presets[action.index])throw Error('Unknown workspace preset');next.snapshot=structuredClone(next.presets[action.index]);break;
  case 'delete-preset':next.presets.splice(action.index,1);break;
  case 'import':{const design=parseDesign(action.text);if(design.format==='deckcraft.component')appendDesign(snapshot,design);else next.snapshot=design;break;}
  default:return state;
 }
 validateDesignSchema(next,wsStorageSchema);validateWorkspace(next.snapshot);next.presets.forEach(validateWorkspace);
 if(JSON.stringify(next).length>1048576)throw Error('Workspace storage exceeds 1 MiB');
 return next;
}
export const CREATOR_CAPABILITIES={version:1,engineDecks:DECK_IDS,componentKinds:COMPONENT_KINDS,native:['local-file import','play','pause','seek','manual cues','channel volume','A/B crossfader'],unavailable:['EQ','FX','loops','sync','pitch/time stretching','meters','headphone routing','beat/key analysis'],boundary:'Presentation only. Removing a view never unloads audio. Browser-only previews have no audio. No scripts, raw CSS/HTML, URLs, filesystem paths or new command bindings.'};
export function creatorKit(component=createComponent()) {
 const example=validateComponent(component);
 const schemas={component:COMPONENT_SCHEMA,workspace:WORKSPACE_SCHEMA};
 const instructions=`# DeckCraft component creator\n\nThis kit matches component format version 1. Edit component.json, not application source. Styling only: do not add functionality or invent fields. The deck property binds existing controls to A/B/C/D. Mixer always shows all four channels; browser uses the shared load target.\n\nUse six-digit hex colors, radius 0..24, fontScale 90..120, density compact/comfortable, and boolean parts. Keep all required fields. No executable code, HTML, CSS, URLs, music or paths. Component size/position belong to workspace items, not component designs.\n\nRun: node validate.mjs component.json\nImport the result using Canvas → AI creator kit → paste/upload → Validate & preview → Add component. A workspace import replaces only the canvas, not playback; review before applying. Preview data is synthetic and controls are inert. Resize and inspect the live component in Edit mode, then lock Perform mode.\n\nSupported kinds: ${COMPONENT_KINDS.join(', ')}. Effects are disabled placeholders, not processors. Browser-only builds do not play music. Native capabilities and unavailable features are in capabilities.json. Do not claim audible EQ/FX or implement custom DSP in this format.\n\nA kit contains only design data. Return component.json, not the whole kit. The schemas, validator and examples ship together so agents need not reverse-engineer DeckCraft.\n`;
 const validator=`import {readFile} from 'node:fs/promises';\nconst schemas=${JSON.stringify(schemas)};\nconst validateDesignSchema=${validateDesignSchema.toString()};\ntry { const text=await readFile(process.argv[2],'utf8');if(Buffer.byteLength(text)>${DESIGN_LIMIT})throw Error('Design exceeds 256 KiB');const value=JSON.parse(text);const schema=value.format==='deckcraft.component'?schemas.component:value.format==='deckcraft.workspace'?schemas.workspace:null;if(!schema)throw Error('Unknown format');validateDesignSchema(value,schema);if(value.items&&new Set(value.items.map(i=>i.id)).size!==value.items.length)throw Error('Duplicate item IDs');console.log(JSON.stringify({ok:true,format:value.format,version:value.version})); } catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}\n`;
 return {format:'deckcraft.creator-kit',version:1,files:{'AGENTS.md':instructions,'component.json':JSON.stringify(example,null,2),'component.schema.json':JSON.stringify(COMPONENT_SCHEMA,null,2),'workspace.schema.json':JSON.stringify(WORKSPACE_SCHEMA,null,2),'capabilities.json':JSON.stringify(CREATOR_CAPABILITIES,null,2),'validate.mjs':validator,'examples.json':JSON.stringify(COMPONENT_KINDS.map(kind=>createComponent(kind)),null,2)}};
}
