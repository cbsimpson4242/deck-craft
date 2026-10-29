import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const modules=['catalog.js','session.js','workspace.js','store.js','components.js','library.js','canvas-view.js','views.js','canvas-editor.js','native.js','main.js'];
let code='';
for(const filename of modules) {
  const source=await readFile(path.join(root,'src',filename),'utf8');
  code+='\n// '+filename+'\n'+source.replace(/^import .*;\r?\n/gm,'').replace(/^export\s+/gm,'');
}
// These modules use unique top-level names and one-line static imports. Syntax is
// checked by the tests and the bundled script is executed in real Chromium.
const css=(await readFile(path.join(root,'src/approved.css'),'utf8'))+'\n'+await readFile(path.join(root,'src/app.css'),'utf8')+'\n'+await readFile(path.join(root,'src/native.css'),'utf8')+'\n'+await readFile(path.join(root,'src/canvas.css'),'utf8')+'\n'+await readFile(path.join(root,'src/themes.css'),'utf8');
const icon=await readFile(path.join(root,'assets/deck-craft.svg'),'utf8');
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>Deck Craft</title><link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}"><style>${css}</style></head><body><div id="app"><p>Opening Deck Craft…</p></div><noscript>JavaScript is required for the Deck Craft application UI.</noscript><script type="module">${code.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
await mkdir(path.join(root,'dist'),{recursive:true});
await writeFile(path.join(root,'dist/deck-craft.html'),html);
await writeFile(path.join(root,'dist/bundle-check.mjs'),code);
console.log('Built dist/deck-craft.html — offline application UI; five layouts, one session.');
