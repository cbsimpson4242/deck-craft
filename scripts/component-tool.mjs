// Offline agent tooling. Never reads music, connects to audio, or imports user code.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseDesign, creatorKit, createComponent, DESIGN_LIMIT } from '../src/workspace.js';
import { renderDesignPreview } from '../src/canvas-editor.js';

const [command,input,output]=process.argv.slice(2);
try {
 if(command==='kit') {
  if(!input)throw Error('Usage: node scripts/component-tool.mjs kit <output-folder>');
  await mkdir(input,{recursive:true});
  for(const [name,content] of Object.entries(creatorKit(createComponent()).files))await writeFile(path.join(input,name),content,{flag:'wx'});
  console.log(JSON.stringify({ok:true,files:Object.keys(creatorKit().files)}));
 } else if(command==='validate'||command==='preview') {
  if(!input||(command==='preview'&&!output))throw Error('Usage: node scripts/component-tool.mjs validate <design.json> | preview <design.json> <output.html>');
  if((await stat(input)).size>DESIGN_LIMIT)throw Error('Design exceeds 256 KiB');
  const design=parseDesign(await readFile(input,'utf8'));
  if(command==='preview') {
   const css=(await Promise.all(['approved.css','app.css','native.css','canvas.css','themes.css'].map(name=>readFile(new URL('../src/'+name,import.meta.url),'utf8')))).join('\n');
   const content=renderDesignPreview(design).replace(/<(button|input|select)\b/g,'<$1 disabled').replace(/data-action="[^"]*"/g,'');
   const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>DeckCraft synthetic component preview</title><style>${css}</style><body class="studio refined canvas-mode"><main class="canvas-shell">${content}</main></body></html>`;
   await writeFile(output,html,{flag:'wx'});
  }
  console.log(JSON.stringify({ok:true,format:design.format,version:design.version,preview:command==='preview'?'Synthetic, inert, no audio':undefined}));
 } else throw Error('Commands: kit <folder> | validate <design.json> | preview <design.json> <output.html>');
} catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
