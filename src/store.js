import { createSession, reduceSession, restoreSession, serializeSession } from './session.js';
export const STORAGE_KEY='deck-craft.ui.v1';
const UNSAVED='Changes are not saved on this device. Your current session remains open; allow browser storage to remember it.';

/** Owns all local persistence. Layout renderers never read or write storage. */
export function createStore(storage) {
  let state=createSession(),warning='',lastPersist=0;const listeners=new Set();
  try {
    const restored=restoreSession(storage.getItem(STORAGE_KEY));state=restored.state;
    if(restored.recovered) warning='Recovered a readable session from invalid saved data. Transport is paused.';
  }catch{warning=UNSAVED;}
  return {
    get:()=>state,
    getWarning:()=>warning,
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
