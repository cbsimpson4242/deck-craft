import { DEFAULT_LAYOUT, DECK_IDS, LAYOUTS, TRACKS, trackById } from './catalog.js';

const LIMITS = {pitch:[-8,8],gain:[0,100],hi:[0,100],mid:[0,100],low:[0,100],filter:[0,100],level:[0,100]};
const FLAGS = ['playing','sync','headphone','loopEnabled'];
const LOOP_LENGTHS = [1,2,4,8,16,32];
const validLayout = id => LAYOUTS.some(layout => layout.id === id);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (obj,key) => Object.prototype.hasOwnProperty.call(obj,key);

function initialDeck(track) {
  return {trackId:track.id,position:92.4,playing:false,cues:[0,48,136,208],loopLength:8,loopEnabled:false,pitch:0,sync:false,headphone:false,gain:50,hi:50,mid:50,low:50,filter:50,level:78};
}
export function createSession() {
  return {version:1,layout:DEFAULT_LAYOUT,decks:Object.fromEntries(DECK_IDS.map((id,i)=>[id,initialDeck(TRACKS[i])])),mixer:{crossfader:50,effects:{echo:{enabled:false,wet:25},space:{enabled:false,wet:20}}},library:{query:'',crate:'all',target:'A',dense:false},mode:'perform',pair:'ab'};
}

/** One semantic session. A layout transition changes presentation only. */
export function reduceSession(state,action) {
  if (!object(action)) return state;
  if (action.type === 'layout') return validLayout(action.value) && action.value !== state.layout ? {...state,layout:action.value} : state;
  if (action.type === 'mode') return ['perform','prepare'].includes(action.value) ? {...state,mode:action.value} : state;
  if (action.type === 'pair') return ['ab','cd'].includes(action.value) ? {...state,pair:action.value} : state;
  if (action.type === 'library') {
    const {field,value}=action;
    const valid = (field==='query'&&typeof value==='string') || (field==='crate'&&['all',...TRACKS.map(t=>t.genre)].includes(value)) || (field==='target'&&DECK_IDS.includes(value)) || (field==='dense'&&typeof value==='boolean');
    return valid ? {...state,library:{...state.library,[field]:field==='query'?value.slice(0,240):value}} : state;
  }
  if (action.type === 'mixer') return action.field==='crossfader' && finite(action.value) ? {...state,mixer:{...state.mixer,crossfader:clamp(action.value,0,100)}} : state;
  if (action.type === 'fx') {
    const {effect,field,value}=action;
    if (!['echo','space'].includes(effect) || !((field==='enabled'&&typeof value==='boolean')||(field==='wet'&&finite(value)))) return state;
    return {...state,mixer:{...state.mixer,effects:{...state.mixer.effects,[effect]:{...state.mixer.effects[effect],[field]:field==='wet'?clamp(value,0,100):value}}}};
  }
  if (!DECK_IDS.includes(action.deck)) return state;
  const current=state.decks[action.deck]; let next;
  if (action.type === 'load') {
    const track=trackById(action.trackId); if(!track) return state;
    next={...current,trackId:track.id,position:0,playing:false,sync:false,cues:[0,48,136,208].map(value=>Math.min(value,track.duration))};
  } else if(action.type === 'cue') {
    next={...current,position:0,playing:false};
  } else if(action.type==='setCue'||action.type==='hotCue') {
    if(!Number.isInteger(action.index)||action.index<0||action.index>3) return state;
    if(action.type==='setCue') {const cues=[...current.cues];cues[action.index]=current.position;next={...current,cues};}
    else next={...current,position:current.cues[action.index]};
  } else if(action.type === 'deck') {
    const {field,value}=action;
    if(FLAGS.includes(field)&&typeof value==='boolean') next={...current,[field]:value};
    else if(field==='position'&&finite(value)) next={...current,position:clamp(value,0,trackById(current.trackId).duration)};
    else if(own(LIMITS,field)&&finite(value)) next={...current,[field]:clamp(value,...LIMITS[field])};
    else if(field==='loopLength'&&LOOP_LENGTHS.includes(value)) next={...current,loopLength:value};
    else return state;
  } else return state;
  return {...state,decks:{...state.decks,[action.deck]:next}};
}
export function serializeSession(state) { return JSON.stringify(state); }

/** Restore only known, bounded fields; opening a saved session never starts transport. */
export function restoreSession(text) {
  const initial=createSession();
  if(text===null||text===undefined||text==='') return {state:initial,recovered:false};
  let saved;
  try {if(typeof text!=='string'||text.length>100000) throw new Error('Invalid state');saved=JSON.parse(text);}catch{return {state:initial,recovered:true};}
  if(!object(saved)||saved.version!==1) return {state:initial,recovered:true};
  let recovered=false;
  const state={...initial};
  if(validLayout(saved.layout)) state.layout=saved.layout; else recovered=true;
  if(['perform','prepare'].includes(saved.mode)) state.mode=saved.mode;
  if(['ab','cd'].includes(saved.pair)) state.pair=saved.pair;
  for(const id of DECK_IDS) {
    const raw=object(saved.decks)?saved.decks[id]:null;
    if(!object(raw)){recovered=true;continue;}
    const track=trackById(raw.trackId);if(!track){recovered=true;continue;}
    let deck={...initial.decks[id],trackId:track.id};
    if(finite(raw.position)) deck.position=clamp(raw.position,0,track.duration);else recovered=true;
    for(const field of ['sync','headphone','loopEnabled']) if(typeof raw[field]==='boolean') deck[field]=raw[field];
    for(const [field,[min,max]] of Object.entries(LIMITS)) if(finite(raw[field])) deck[field]=clamp(raw[field],min,max);
    if(LOOP_LENGTHS.includes(raw.loopLength)) deck.loopLength=raw.loopLength;
    if(Array.isArray(raw.cues)&&raw.cues.length===4) deck.cues=raw.cues.map((value,i)=>finite(value)?clamp(value,0,track.duration):deck.cues[i]);
    deck.playing=false; state.decks[id]=deck;
  }
  if(object(saved.mixer)) {
    if(finite(saved.mixer.crossfader)) state.mixer.crossfader=clamp(saved.mixer.crossfader,0,100);
    for(const effect of ['echo','space']) {
      const raw=object(saved.mixer.effects)?saved.mixer.effects[effect]:null;
      if(object(raw)) {
        if(typeof raw.enabled==='boolean') state.mixer.effects[effect].enabled=raw.enabled;
        if(finite(raw.wet)) state.mixer.effects[effect].wet=clamp(raw.wet,0,100);
      }
    }
  }
  if(object(saved.library)) for(const field of ['query','crate','target','dense']) {
    const updated=reduceSession(state,{type:'library',field,value:saved.library[field]});state.library=updated.library;
  }
  return {state,recovered};
}
