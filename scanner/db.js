// Ablage der Dokumente lokal im Browser (IndexedDB). Nichts verlässt das Gerät.
const DB = 'scanner', STORE = 'docs';
let dbp = null;

function open() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const out = fn(s);
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Speichern abgebrochen (Speicher voll?)'));
  });
}

export const putDoc = doc => tx('readwrite', s => s.put(doc));
export const getDoc = id => tx('readonly', s => s.get(id));
export const deleteDoc = id => tx('readwrite', s => s.delete(id));
export const allDocs = () => tx('readonly', s => s.getAll());

export function persist() {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
