const DB_NAME = "maleta-mvp";
const DB_VERSION = 2;
const STORES = ["recordings", "classes", "drafts", "chunks"];

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) {
          request.result.createObjectStore(name, { keyPath: "id" });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(name, mode, operation) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(name, mode);
    const store = transaction.objectStore(name);
    const result = await operation(store);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
    return result;
  } finally {
    database.close();
  }
}

export const db = {
  all: (store) => withStore(store, "readonly", (target) => requestResult(target.getAll())),
  get: (store, id) => withStore(store, "readonly", (target) => requestResult(target.get(id))),
  put: (store, value) => withStore(store, "readwrite", (target) => requestResult(target.put(value))),
  delete: (store, id) => withStore(store, "readwrite", (target) => requestResult(target.delete(id))),
  clear: (store) => withStore(store, "readwrite", (target) => requestResult(target.clear())),
};

export function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
}
