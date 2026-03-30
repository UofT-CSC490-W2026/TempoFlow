const DB_NAME = 'TempoFlowVideos';
const STORE_NAME = 'videos';
const DB_VERSION = 1;

export type SessionVideoRole = 'reference' | 'practice' | 'reference-sam3' | 'practice-sam3';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

function buildSessionVideoKey(sessionId: string, role: SessionVideoRole) {
  return `${sessionId}:${role}`;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const request = callback(store);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function storeVideo(key: string, file: File): Promise<void> {
  await withStore('readwrite', (store) => store.put(file, key));
}

export async function getVideo(key: string): Promise<File | null> {
  return (await withStore('readonly', (store) => store.get(key))) || null;
}

export async function deleteVideo(key: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(key));
}

export async function clearVideos(): Promise<void> {
  await withStore('readwrite', (store) => store.clear());
}

export async function storeSessionVideo(sessionId: string, role: SessionVideoRole, file: File): Promise<void> {
  await storeVideo(buildSessionVideoKey(sessionId, role), file);
}

export async function getSessionVideo(sessionId: string, role: SessionVideoRole): Promise<File | null> {
  return getVideo(buildSessionVideoKey(sessionId, role));
}

export async function deleteSessionVideos(sessionId: string): Promise<void> {
  await Promise.all([
    deleteVideo(buildSessionVideoKey(sessionId, 'reference')),
    deleteVideo(buildSessionVideoKey(sessionId, 'practice')),
    deleteVideo(buildSessionVideoKey(sessionId, 'reference-sam3')),
    deleteVideo(buildSessionVideoKey(sessionId, 'practice-sam3')),
  ]);
}
