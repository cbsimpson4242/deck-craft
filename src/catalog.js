export const LAYOUTS = Object.freeze([
  { id: 'signal-one', name: 'Signal One', classes: 'signal refined s-one', decks: 2 },
  { id: 'signal-wide', name: 'Signal Wide', classes: 'signal refined s-wide', decks: 2 },
  { id: 'studio-grid', name: 'Studio Grid', classes: 'studio refined s-grid', decks: 4 },
  { id: 'studio-linear', name: 'Studio Linear', classes: 'studio refined s-linear', decks: 4 },
  { id: 'studio-sync', name: 'Studio Sync', classes: 'studio refined s-sync', decks: 4 }
]);
export const DECK_IDS = Object.freeze(['A', 'B', 'C', 'D']);
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
export const trackById = id => TRACKS.find(track => track.id === id);
