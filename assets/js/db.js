const DB_NAME = "maleta-mvp";
const DB_VERSION = 3;
const STORES = ["recordings", "classes", "drafts", "chunks", "audio"];

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* Audio used to live on the recording record itself, which meant every blob was
   read into memory whenever the library loaded. Version 3 moves blobs into their
   own store so metadata stays cheap and audio is fetched only when it is played. */
function migrateAudioOut(transaction) {
  const recordings = transaction.objectStore("recordings");
  const audio = transaction.objectStore("audio");
  recordings.openCursor().onsuccess = (event) => {
    const cursor = event.target.result;
    if (!cursor) return;
    const value = cursor.value;
    if (value.audio) {
      audio.put({ id: value.id, blob: value.audio });
      delete value.audio;
      value.hasAudio = true;
      cursor.update(value);
    }
    cursor.continue();
  };
}

let connection = null;

export function openDatabase() {
  if (connection) return Promise.resolve(connection);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) {
          request.result.createObjectStore(name, { keyPath: "id" });
        }
      }
      if (event.oldVersion > 0 && event.oldVersion < 3) migrateAudioOut(request.transaction);
    };
    request.onsuccess = () => {
      connection = request.result;
      /* Drop the cached handle if the connection is closed underneath us, so the
         next call opens a fresh one instead of throwing on a dead database. */
      connection.onclose = () => { connection = null; };
      connection.onversionchange = () => { connection?.close(); connection = null; };
      resolve(connection);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Il database è in uso da un’altra scheda."));
  });
}

/* Accepts one store name or several. A multi-store transaction is what makes
   saving audio + metadata, or deleting both, genuinely atomic: either the whole
   transaction commits or none of it does. */
async function withStore(names, mode, operation) {
  const database = await openDatabase();
  const list = Array.isArray(names) ? names : [names];
  const transaction = database.transaction(list, mode);
  const stores = list.map((name) => transaction.objectStore(name));
  const result = await operation(Array.isArray(names) ? stores : stores[0]);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
  return result;
}

/* Chunk ids are `${draftId}_${paddedSequence}`, so a prefix range selects exactly
   one draft's chunks without reading every blob in the store. */
function prefixRange(prefix) {
  return IDBKeyRange.bound(prefix, `${prefix}￿`);
}

export const db = {
  all: (store) => withStore(store, "readonly", (target) => requestResult(target.getAll())),
  get: (store, id) => withStore(store, "readonly", (target) => requestResult(target.get(id))),
  put: (store, value) => withStore(store, "readwrite", (target) => requestResult(target.put(value))),
  delete: (store, id) => withStore(store, "readwrite", (target) => requestResult(target.delete(id))),
  clear: (store) => withStore(store, "readwrite", (target) => requestResult(target.clear())),
  keys: (store) => withStore(store, "readonly", (target) => requestResult(target.getAllKeys())),
  allByPrefix: (store, prefix) => withStore(store, "readonly", (target) => requestResult(target.getAll(prefixRange(prefix)))),
  deleteByPrefix: (store, prefix) => withStore(store, "readwrite", (target) => requestResult(target.delete(prefixRange(prefix)))),
  /* Runs several writes across stores in one transaction. Requests do not need
     to be awaited individually; the transaction settles when they all finish. */
  write: (stores, operation) => withStore(stores, "readwrite", operation),
};

export function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
}
