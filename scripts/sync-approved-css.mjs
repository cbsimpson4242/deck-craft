import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=await readFile(path.join(root,'designs/round-three/signal-one/index.html'),'utf8');
const match=source.match(/<style>([\s\S]*?)<\/style>/);
if(!match) throw new Error('Approved stylesheet was not found');
await writeFile(path.join(root,'src/approved.css'),'/* Preserved visual system from approved Round 03; layouts share this stylesheet. */\n'+match[1]);
console.log('Copied the complete approved stylesheet; reference files unchanged.');
