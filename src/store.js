import { createSession, reduceSession, restoreSession, serializeSession } from './session.js';
import { createWorkspace, restoreWorkspace, reduceWorkspace } from './workspace.js';
export const STORAGE_KEY='deck-craft.ui.v1';
export const WORKSPACE_KEY='deck-craft.workspace.v1';
const UNSAVED='Changes are not saved on this device. Your current session remains open; allow browser storage to remember it.';

/** Owns all local persistence. Layout renderers never read or write storage. */
export function createStore(storage) {
  let state=createSession(),warning='',lastPersist=0;const listeners=new Set();
  let workspace=createWorkspace(),workspaceWarning='';const undo=[],redo=[];
  try {
    const restored=restoreSession(storage.getItem(STORAGE_KEY));state=restored.state;
    if(restored.recovered) warning='Recovered a readable session from invalid saved data. Transport is paused.';
  }catch{warning=UNSAVED;}
  try {workspace=restoreWorkspace(storage.getItem(WORKSPACE_KEY));}
  catch {workspaceWarning='Saved workspace could not be restored. The original saved data is untouched; an empty canvas is available.';}
  function saveWorkspace() {
    try {storage.setItem(WORKSPACE_KEY,JSON.stringify(workspace));workspaceWarning='';}
    catch {workspaceWarning='Workspace changes are not saved on this device. The current canvas remains open; export it before closing.';}
  }
  return {
    get:()=>state,
    getWarning:()=>[warning,workspaceWarning].filter(Boolean).join(' '),
    getWorkspace:()=>workspace,
    getWorkspaceHistory:()=>({undo:undo.length,redo:redo.length}),
    dispatchWorkspace(action) {
      if(action.type==='undo'||action.type==='redo') {
        const from=action.type==='undo'?undo:redo,to=action.type==='undo'?redo:undo;
        if(!from.length)return;
        to.push(workspace);workspace={...from.pop(),active:workspace.active};
      } else {
        const next=reduceWorkspace(workspace,action);if(next===workspace)return;
        if(action.type!=='active'){undo.push(workspace);if(undo.length>40)undo.shift();redo.length=0;}
        workspace=next;
      }
      saveWorkspace();for(const fn of listeners)fn(state,{type:'workspace',action});
    },
    dispatch(action) {
      const next=reduceSession(state,action);if(next===state) return;
      const transportChanged=Object.keys(state.decks).some(id=>state.decks[id].playing!==next.decks[id].playing||(!next.decks[id].playing&&state.decks[id].position!==next.decks[id].position));
      state=next;
      if(action.type!=='native-clock'||transportChanged||Date.now()-lastPersist>=1000){
        try {storage.setItem(STORAGE_KEY,serializeSession(state));warning='';lastPersist=Date.now();}catch{warning=UNSAVED;}
      }
      for(const fn of listeners) fn(state,action);
    },
    subscribe(fn) {listeners.add(fn);return ()=>listeners.delete(fn);}
  };
}
