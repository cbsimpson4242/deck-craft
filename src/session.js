import { DEFAULT_LAYOUT, DEFAULT_THEME, DECK_IDS, LAYOUTS, LEGACY_LAYOUTS, THEMES, TRACKS, trackById } from './catalog.js';
import { MIXER_VALUE_FIELDS } from './mixer.js';

const LIMITS = {pitch:[-8,8],gain:[0,100],hi:[0,100],mid:[0,100],low:[0,100],filter:[0,100],level:[0,100]};
const FLAGS = ['playing','sync','headphone','loopEnabled','pitchLock'];
export const EQ_BANDS = ['hi','mid','low'];
export const ASSIGNMENTS = ['left','thru','right'];
/** A and B keep their crossfader sides; C and D stay direct until assigned (the pre-assignment behavior). */
export const DEFAULT_ASSIGN = {A:'left',B:'right',C:'thru',D:'thru'};
/** Knob 50 is neutral. A killed band restores to the value it had, or to this when nothing was remembered. */
export const EQ_NEUTRAL = 50;
const remembered = value => finite(value) && value > 0 && value <= 100 ? value : null;
const LOOP_LENGTHS = [1,2,4,8,16,32];
const validLayout = id => LAYOUTS.some(layout => layout.id === id);
const validTheme = id => THEMES.some(theme => theme.id === id);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (obj,key) => Object.prototype.hasOwnProperty.call(obj,key);

function initialDeck(track,id) {
  return {trackId:track.id,position:92.4,playing:false,cues:[0,48,136,208],loopLength:8,loopEnabled:false,pitch:0,pitchLock:true,sync:false,headphone:false,gain:50,hi:50,mid:50,low:50,filter:50,level:78,assign:DEFAULT_ASSIGN[id],eqRestore:{hi:null,mid:null,low:null}};
}
export function createSession() {
  return {version:1,layout:DEFAULT_LAYOUT,theme:DEFAULT_THEME,decks:Object.fromEntries(DECK_IDS.map((id,i)=>[id,initialDeck(TRACKS[i],id)])),mixer:{crossfader:50,effects:{echo:{enabled:false,wet:25},space:{enabled:false,wet:20}}},library:{query:'',crate:'all',target:'A',dense:false,sort:'title'},mode:'perform',pair:'ab',master:null};
}

/** One semantic session. A layout transition changes presentation only. */
export function reduceSession(state,action) {
  if (!object(action)) return state;
  if(action.type==='native-clock') {
    const snap=action.snapshot;if(!snap||typeof snap.ready!=='boolean'||!Array.isArray(snap.decks))return state;
    const decks={...state.decks};let changed=false;
    for(const id of DECK_IDS){const old=decks[id],native=snap.decks.find(d=>d.id===id);let next=old;
      if((!snap.ready||(native&&native.trackId!==old.trackId))&&old.playing)next={...old,playing:false};
      else if(snap.ready&&native&&native.trackId===old.trackId&&trackById(old.trackId)?.local&&Number.isFinite(native.position)&&typeof native.playing==='boolean'){
        const position=clamp(native.position,0,trackById(old.trackId).duration);
        if(position!==old.position||native.playing!==old.playing)next={...old,position,playing:native.playing};
      }
      if(snap.ready&&native&&native.trackId===old.trackId){
        // Tempo, pitch lock and sync are engine receipts for the loaded source (never mixer-restore state).
        if(finite(native.rate)&&native.rate>=0.92&&native.rate<=1.08){const pitch=Math.round((native.rate-1)*100000000)/1000000;if(pitch!==next.pitch)next={...next,pitch};}
        if(typeof native.pitchLock==='boolean'&&native.pitchLock!==next.pitchLock)next={...next,pitchLock:native.pitchLock};
        if(typeof native.synced==='boolean'&&native.synced!==next.sync)next={...next,sync:native.synced};
      }
      // Native receipts own every channel-strip value once the saved ones have been restored to the
      // engine (`mixer:false` marks the restore window, where the engine still reports its defaults).
      if(snap.ready&&native&&action.mixer!==false)for(const field of MIXER_VALUE_FIELDS)
        if(finite(native[field])&&native[field]>=0&&native[field]<=100&&native[field]!==next[field])next={...next,[field]:native[field]};
      if(snap.ready&&native&&action.mixer!==false) {
        if(ASSIGNMENTS.includes(native.assign)&&native.assign!==next.assign)next={...next,assign:native.assign};
        if(EQ_BANDS.some(b=>next[b]>0&&next.eqRestore?.[b]!=null))next={...next,eqRestore:Object.fromEntries(EQ_BANDS.map(b=>[b,next[b]>0?null:next.eqRestore[b]]))};
      }
      if(next!==old){decks[id]=next;changed=true;}
    }
    const mixer=snap.ready&&action.mixer!==false&&finite(snap.crossfader)&&snap.crossfader>=0&&snap.crossfader<=100&&snap.crossfader!==state.mixer.crossfader?{...state.mixer,crossfader:snap.crossfader}:state.mixer;
    const master=snap.ready&&DECK_IDS.includes(snap.master)?snap.master:state.master;
    return changed||mixer!==state.mixer||master!==state.master?{...state,decks,mixer,master}:state;
  }
  if(action.type==='master')return DECK_IDS.includes(action.deck)?{...state,master:action.deck}:state;
  if (action.type === 'layout') return validLayout(action.value) && action.value !== state.layout ? {...state,layout:action.value} : state;
  if (action.type === 'theme') return validTheme(action.value) && action.value !== state.theme ? {...state,theme:action.value} : state;
  if (action.type === 'mode') return ['perform','prepare'].includes(action.value) ? {...state,mode:action.value} : state;
  if (action.type === 'pair') return ['ab','cd'].includes(action.value) ? {...state,pair:action.value} : state;
  if (action.type === 'library') {
    const {field,value}=action;
    const valid = (field==='query'&&typeof value==='string') || (field==='crate'&&typeof value==='string'&&(['all','demo',...TRACKS.map(t=>t.genre)].includes(value)||/^collection-[0-9a-f-]{36}$/.test(value))) || (field==='target'&&DECK_IDS.includes(value)) || (field==='dense'&&typeof value==='boolean') || (field==='sort'&&['title','duration','order'].includes(value));
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
    next={...current,trackId:track.id,position:0,playing:false,sync:false,cues:(track.local?[0,0,0,0]:[0,48,136,208]).map(value=>Math.min(value,track.duration))};
  } else if(action.type === 'cue') {
    next={...current,position:0,playing:false};
  } else if(action.type==='setCue'||action.type==='hotCue') {
    if(!Number.isInteger(action.index)||action.index<0||action.index>3) return state;
    if(action.type==='setCue') {const cues=[...current.cues];cues[action.index]=current.position;next={...current,cues};}
    else next={...current,position:current.cues[action.index]};
  } else if(action.type==='assign') {
    if(!ASSIGNMENTS.includes(action.value)) return state;
    next={...current,assign:action.value};
  } else if(action.type==='eq-kill'||action.type==='eq-memory') {
    // Clicking a band label removes the band (knob 0) and remembers the knob position; clicking again restores it.
    if(!EQ_BANDS.includes(action.band)) return state;
    const band=action.band,value=current[band],saved=current.eqRestore?.[band]??null;
    if(action.type==='eq-memory') {
      const kept=action.value===null?null:remembered(action.value);
      if((kept===null&&action.value!==null)||(kept!==null&&value!==0)) return state;
      next=kept===saved?current:{...current,eqRestore:{...current.eqRestore,[band]:kept}};
    } else {
      const kill=typeof action.kill==='boolean'?action.kill:value>0;
      if(kill) next=value>0?{...current,[band]:0,eqRestore:{...current.eqRestore,[band]:value}}:current;
      else next=value===0?{...current,[band]:remembered(saved)??EQ_NEUTRAL,eqRestore:{...current.eqRestore,[band]:null}}:current;
    }
    if(next===current) return state;
  } else if(action.type === 'deck') {
    const {field,value}=action;
    if(FLAGS.includes(field)&&typeof value==='boolean') next={...current,[field]:value};
    else if(field==='position'&&finite(value)) next={...current,position:clamp(value,0,trackById(current.trackId).duration)};
    else if(own(LIMITS,field)&&finite(value)) {
      next={...current,[field]:clamp(value,...LIMITS[field])};
      if(EQ_BANDS.includes(field)&&next[field]>0&&current.eqRestore?.[field]!=null) next.eqRestore={...current.eqRestore,[field]:null};
    }
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
  if(DECK_IDS.includes(saved.master))state.master=saved.master;
  if(validLayout(saved.layout)) state.layout=saved.layout; else if(!LEGACY_LAYOUTS.includes(saved.layout)) recovered=true;
  if(validTheme(saved.theme)) state.theme=saved.theme;
  if(['perform','prepare'].includes(saved.mode)) state.mode=saved.mode;
  if(['ab','cd'].includes(saved.pair)) state.pair=saved.pair;
  for(const id of DECK_IDS) {
    const raw=object(saved.decks)?saved.decks[id]:null;
    if(!object(raw)){recovered=true;continue;}
    const track=trackById(raw.trackId);if(!track){recovered=true;continue;}
    let deck={...initial.decks[id],trackId:track.id};
    if(finite(raw.position)) deck.position=clamp(raw.position,0,track.duration);else recovered=true;
    for(const field of ['sync','headphone','loopEnabled','pitchLock']) if(typeof raw[field]==='boolean') deck[field]=raw[field];
    for(const [field,[min,max]] of Object.entries(LIMITS)) if(finite(raw[field])) deck[field]=clamp(raw[field],min,max);
    if(own(raw,'assign')) {if(ASSIGNMENTS.includes(raw.assign))deck.assign=raw.assign;else recovered=true;}
    if(object(raw.eqRestore))deck.eqRestore=Object.fromEntries(EQ_BANDS.map(b=>[b,deck[b]===0?remembered(raw.eqRestore[b]):null]));
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
  if(object(saved.library)) for(const field of ['query','crate','target','dense','sort']) {
    const updated=reduceSession(state,{type:'library',field,value:saved.library[field]});state.library=updated.library;
  }
  return {state,recovered};
}
