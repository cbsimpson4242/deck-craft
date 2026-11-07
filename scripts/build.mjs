import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const modules=['mixer.js','catalog.js','scrub.js','session.js','workspace.js','store.js','wave-zoom.js','wave-render.js','components.js','library.js','canvas-view.js','views.js','canvas-editor.js','frame.js','wave-input.js','browser-analysis.js','browser-artwork.js','browser-store.js','browser-audio.js','backends.js','native.js','drag-load.js','main.js'];
let code='';
for(const filename of modules) {
  const source=await readFile(path.join(root,'src',filename),'utf8');
  code+='\n// '+filename+'\n'+source.replace(/^import .*;\r?\n/gm,'').replace(/^export\s+/gm,'');
}
// These modules use unique top-level names and one-line static imports. Syntax is
// checked by the tests and the bundled script is executed in real Chromium.
const css=(await readFile(path.join(root,'src/app.css'),'utf8'))+'\n'+await readFile(path.join(root,'src/native.css'),'utf8')+'\n'+await readFile(path.join(root,'src/canvas.css'),'utf8')+'\n'+await readFile(path.join(root,'src/themes.css'),'utf8');
const icon=await readFile(path.join(root,'assets/deck-craft.svg'),'utf8');
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>Deck Craft</title><link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}"><style>${css}</style></head><body><div id="app"><p>Opening Deck Craft…</p></div><noscript>JavaScript is required for the Deck Craft application UI.</noscript><script type="module">${code.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
// DECKCRAFT_DIST selects another output directory (development builds); the default stays dist/.
const dist=process.env.DECKCRAFT_DIST?path.resolve(process.env.DECKCRAFT_DIST):path.join(root,'dist');
await mkdir(dist,{recursive:true});
await writeFile(path.join(dist,'deck-craft.html'),html);
await writeFile(path.join(dist,'bundle-check.mjs'),code);
console.log('Built '+path.join(path.relative(root,dist)||'.','deck-craft.html')+' — application UI; four decks, one session; native bridge or in-browser audio.');
