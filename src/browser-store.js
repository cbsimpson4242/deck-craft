// Bounded browser-local file storage. Selected audio files are kept as Blobs in
// this browser's IndexedDB (never uploaded). Storage failures degrade to
// session-only sources that are clearly marked reselect-after-reload.

export const BROWSER_STORAGE_LIMITS = Object.freeze({
  fileBytes: 64 * 1024 * 1024,
  persistedBytes: 768 * 1024 * 1024,
  sessionBytes: 384 * 1024 * 1024,
  tracks: 500,
  batchFiles: 100,
  batchBytes: 256 * 1024 * 1024,
  durationSeconds: 1200,
});
const DATABASE = 'deck-craft-browser-library';
const LIBRARY_KEY = 'library';

/** crypto.randomUUID is secure-context only; getRandomValues also works on plain HTTP. */
export function browserUUID(source = globalThis.crypto) {
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  if (typeof source?.getRandomValues !== 'function') throw Error('secure_random_unavailable');
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const finished = tx => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || Error('transaction_aborted')); });

export class BrowserFileStore {
  constructor(factory = globalThis.indexedDB) { this.factory = factory; this.db = null; }
  /** Opens storage; resolves false (never throws) when IndexedDB is unavailable. */
  async open() {
    if (!this.factory) return false;
    try {
      this.db = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('timeout')), 5000); // a stuck private-mode database must not block startup
        const opening = this.factory.open(DATABASE, 1);
        opening.onupgradeneeded = () => { opening.result.createObjectStore('blobs'); opening.result.createObjectStore('meta'); };
        opening.onsuccess = () => { clearTimeout(timer); resolve(opening.result); };
        opening.onerror = () => { clearTimeout(timer); reject(opening.error); };
        opening.onblocked = () => { clearTimeout(timer); reject(Error('blocked')); };
      });
      this.db.onversionchange = () => { this.db.close(); this.db = null; };
      return true;
    } catch { this.db = null; return false; }
  }
  get available() { return !!this.db; }
  async readLibrary() {
    if (!this.db) return null;
    return request(this.db.transaction('meta').objectStore('meta').get(LIBRARY_KEY));
  }
  /** Atomically replaces the metadata document; throws (e.g. QuotaExceededError) on failure. */
  async writeLibrary(document) {
    const tx = this.db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(document, LIBRARY_KEY);
    await finished(tx);
  }
  async putBlob(id, blob) {
    const tx = this.db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put(blob, id);
    await finished(tx);
  }
  async getBlob(id) {
    if (!this.db) return null;
    return (await request(this.db.transaction('blobs').objectStore('blobs').get(id))) || null;
  }
  async deleteBlobs(ids) {
    if (!this.db || !ids.length) return;
    const tx = this.db.transaction('blobs', 'readwrite');
    for (const id of ids) tx.objectStore('blobs').delete(id);
    await finished(tx);
  }
  /** Removes blobs the metadata no longer references (interrupted imports). */
  async collectOrphans(keep) {
    if (!this.db) return 0;
    const keys = await request(this.db.transaction('blobs').objectStore('blobs').getAllKeys());
    const orphans = keys.filter(key => !keep.has(key));
    await this.deleteBlobs(orphans);
    return orphans.length;
  }
  close() { this.db?.close(); this.db = null; }
}

export const quotaError = error => error?.name === 'QuotaExceededError' || error?.code === 22;
