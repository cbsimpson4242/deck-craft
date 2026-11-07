/** One flagship layout. Earlier saved sessions named one of five retired layouts; they restore silently into this one. */
export const LAYOUTS = Object.freeze([
  { id: 'console', name: 'Console', classes: 'console', decks: 4 }
]);
export const LEGACY_LAYOUTS = Object.freeze(['signal-one', 'signal-wide', 'studio-grid', 'studio-linear', 'studio-sync']);
export const DECK_IDS = Object.freeze(['A', 'B', 'C', 'D']);
/** Presentation themes. A theme sets surface/text/accent tokens only; the deck identity hues and waveform treatment are shared. */
export const THEMES = Object.freeze([
  {id:'graphite',name:'Night'},{id:'ember',name:'Ember'},{id:'daylight',name:'Studio'}
]);
export const DEFAULT_THEME = 'graphite';
export const DEFAULT_LAYOUT = 'console';
export const TRACKS = Object.freeze([
  { id:'afterlight', title:'Afterlight', artist:'Forma District', bpm:124, key:'8A', duration:384, genre:'Deep House', color:'#96c7a8' },
  { id:'glass-transit', title:'Glass Transit', artist:'North Circuit', bpm:125, key:'9A', duration:348, genre:'Minimal', color:'#7d9dd5' },
  { id:'low-orbit', title:'Low Orbit', artist:'Parallel Shapes', bpm:123, key:'8A', duration:432, genre:'Deep House', color:'#c19d7b' },
  { id:'soft-machines', title:'Soft Machines', artist:'Mira Assembly', bpm:126, key:'10A', duration:362, genre:'Tech House', color:'#b795c2' },
  { id:'midnight-geometry', title:'Midnight Geometry', artist:'Field Theory', bpm:124, key:'7A', duration:356, genre:'Minimal', color:'#abbb86' },
  { id:'signal-garden', title:'Signal Garden', artist:'Outer Rooms', bpm:122, key:'8B', duration:398, genre:'Ambient', color:'#cc8e83' },
  { id:'open-water', title:'Open Water', artist:'Analog Season', bpm:125, key:'9A', duration:424, genre:'Deep House', color:'#7aaeb1' },
  { id:'last-platform', title:'Last Platform', artist:'Forma District', bpm:124, key:'8A', duration:332, genre:'Minimal', color:'#a396c6' },
  { id:'quiet-motion', title:'Quiet Motion', artist:'Index Assembly', bpm:124, key:'7A', duration:375, genre:'Deep House', color:'#b19d85' },
  { id:'phase-memory', title:'Phase Memory', artist:'Outer Rooms', bpm:123, key:'8B', duration:450, genre:'Ambient', color:'#8ca3b0' },
  { id:'night-service', title:'Night Service', artist:'North Circuit', bpm:126, key:'10A', duration:342, genre:'Tech House', color:'#a68a8e' },
  { id:'half-remembered', title:'Half Remembered', artist:'Field Theory', bpm:125, key:'9A', duration:406, genre:'Minimal', color:'#92ae99' }
]);
const localTracks = new Map();
let playbackBackend = null;
/** Identity of the real audio backend serving the library (native or browser); set once at startup. */
export const setBackendActive = id => { playbackBackend = id || null; };
export const backendActive = () => playbackBackend !== null;
export const browserBackend = () => playbackBackend === 'browser';
let collections = [];
export const libraryCollections = () => collections;
// Session-only fine waveform envelopes sent by the native engine for decks that are loaded now. They
// are never persisted or added to library records; at most a few are kept (four decks) and they are
// dropped with their track.
export const WAVE_DETAIL_MIN_BINS=512,WAVE_DETAIL_MAX_BINS=32768;
const WAVE_DETAIL_KEEP=8,localWaveDetail=new Map();
const base64Bytes=(text,length)=>{
 if(typeof text!=='string'||text.length!==Math.ceil(length/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))return null;
 let binary;try{binary=atob(text);}catch{return null;}
 if(binary.length!==length||btoa(binary)!==text)return null;
 const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 return bytes;
};
export function setLocalWaveDetail(id,detail,loaded=[]) {
 if(!localTracks.has(id)||!detail||typeof detail!=='object'||Array.isArray(detail)||Object.keys(detail).length!==3||!['bins','peak','rms'].every(k=>Object.hasOwn(detail,k)))return null;
 const bins=detail.bins;
 if(!Number.isInteger(bins)||bins<WAVE_DETAIL_MIN_BINS||bins>WAVE_DETAIL_MAX_BINS)return null;
 const peak=base64Bytes(detail.peak,bins),rms=base64Bytes(detail.rms,bins);
 if(!peak||!rms)return null;
 for(let i=0;i<bins;i++)if(rms[i]>peak[i])return null;
 const safe={bins,peak,rms};
 localWaveDetail.delete(id);localWaveDetail.set(id,safe);
 // Evict oldest first, but never an envelope whose track is still on a deck (`loaded`).
 while(localWaveDetail.size>WAVE_DETAIL_KEEP){const victim=[...localWaveDetail.keys()].find(key=>key!==id&&!loaded.slice(0,4).includes(key));if(victim===undefined)break;localWaveDetail.delete(victim);}
 return safe;
}
export const waveDetailById = id => localWaveDetail.get(id);
export function replaceLocalLibrary(tracks, groups = [], protectedIds = []) {
 const next=new Map(tracks.map(track=>{const safe=safeLocalTrack(track);return [safe.id,safe];}));
 if(protectedIds.some(id=>localTracks.has(id)&&!next.has(id)))throw Error('Library update would remove a selected deck track. Reload the application to reconcile the library.');
 const nextCollections=groups.map(c=>({id:c.id,kind:c.kind,name:c.name,trackIds:[...c.trackIds]}));
 localTracks.clear();
 for(const [id,track] of next)localTracks.set(id,track);
 for(const id of [...localWaveDetail.keys()])if(!localTracks.has(id))localWaveDetail.delete(id);
 collections=nextCollections;
}
export const allTracks = () => [...TRACKS,...localTracks.values()];
function safeLocalTrack(track) {
 if(!track || !/^local-[0-9a-f-]{36}$/.test(track.id) || typeof track.title!=='string' || !Number.isFinite(track.duration) || track.duration<=0 || track.duration>7200)throw Error('Invalid local track');
 const peaks=Array.isArray(track.peaks)&&track.peaks.length===512&&track.peaks.every(n=>Number.isFinite(n)&&n>=0&&n<=1)?track.peaks.slice():[];
 const grid=track.beatGrid;const validGrid=grid&&Number.isFinite(grid.bpm)&&grid.bpm>=60&&grid.bpm<=200&&Number.isFinite(grid.offset)&&grid.offset>=0&&grid.offset<1.01&&Number.isFinite(grid.confidence)&&grid.confidence>=0&&grid.confidence<=1;
 const artwork=typeof track.artwork==='string'&&track.artwork.length<=22000&&/^data:image\/png;base64,iVBOR[A-Za-z0-9+/]*={0,2}$/.test(track.artwork)?track.artwork:null;
 const safe={id:track.id,title:track.title.slice(0,512),artist:'Local audio',genre:'Local files',bpm:validGrid?grid.bpm:0,beatGrid:validGrid?{bpm:grid.bpm,offset:grid.offset,confidence:grid.confidence}:null,artwork,analysisVersion:track.analysisVersion===1?1:0,persisted:track.persisted!==false,key:'—',duration:track.duration,color:'#96c7a8',local:true,peaks};
 return safe;
}
export function registerLocalTrack(track) {
 const safe=safeLocalTrack(track);localTracks.set(safe.id,safe);return safe;
}
export const trackById = id => localTracks.get(id) || TRACKS.find(track => track.id === id);
