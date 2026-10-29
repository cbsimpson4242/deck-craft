export const LAYOUTS = Object.freeze([
  { id: 'signal-one', name: 'Signal One', classes: 'signal refined s-one', decks: 2 },
  { id: 'signal-wide', name: 'Signal Wide', classes: 'signal refined s-wide', decks: 2 },
  { id: 'studio-grid', name: 'Studio Grid', classes: 'studio refined s-grid', decks: 4 },
  { id: 'studio-linear', name: 'Studio Linear', classes: 'studio refined s-linear', decks: 4 },
  { id: 'studio-sync', name: 'Studio Sync', classes: 'studio refined s-sync', decks: 4 }
]);
export const DECK_IDS = Object.freeze(['A', 'B', 'C', 'D']);
/** Presentation themes. A theme sets surface/text/accent tokens only; Play, cue blue, deck colors and waveform glass are fixed. */
export const THEMES = Object.freeze([
  {id:'graphite',name:'Graphite'},{id:'midnight',name:'Midnight'},{id:'ember',name:'Ember'},{id:'orchid',name:'Orchid'},{id:'daylight',name:'Daylight'}
]);
export const DEFAULT_THEME = 'graphite';
export const DEFAULT_LAYOUT = 'studio-sync';
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
let collections = [];
export const libraryCollections = () => collections;
export function replaceLocalLibrary(tracks, groups = [], protectedIds = []) {
 const next=new Map(tracks.map(track=>{const safe=safeLocalTrack(track);return [safe.id,safe];}));
 if(protectedIds.some(id=>localTracks.has(id)&&!next.has(id)))throw Error('Library update would remove a selected deck track. Reload the application to reconcile the library.');
 const nextCollections=groups.map(c=>({id:c.id,kind:c.kind,name:c.name,trackIds:[...c.trackIds]}));
 localTracks.clear();
 for(const [id,track] of next)localTracks.set(id,track);
 collections=nextCollections;
}
export const allTracks = () => [...TRACKS,...localTracks.values()];
function safeLocalTrack(track) {
 if(!track || !/^local-[0-9a-f-]{36}$/.test(track.id) || typeof track.title!=='string' || !Number.isFinite(track.duration) || track.duration<=0 || track.duration>7200)throw Error('Invalid local track');
 const peaks=Array.isArray(track.peaks)&&track.peaks.length===512&&track.peaks.every(n=>Number.isFinite(n)&&n>=0&&n<=1)?track.peaks.slice():[];
 const safe={id:track.id,title:track.title.slice(0,512),artist:'Local audio',genre:'Local files',bpm:0,key:'—',duration:track.duration,color:'#96c7a8',local:true,peaks};
 return safe;
}
export function registerLocalTrack(track) {
 const safe=safeLocalTrack(track);localTracks.set(safe.id,safe);return safe;
}
export const trackById = id => localTracks.get(id) || TRACKS.find(track => track.id === id);
