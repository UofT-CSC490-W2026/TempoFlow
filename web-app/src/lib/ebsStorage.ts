import type { EbsData } from "../components/ebs/types";

const DB_NAME = "TempoFlowEbs";
const STORE_NAME = "ebsArtifacts";
const DB_VERSION = 1;

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

function buildSessionEbsKey(sessionId: string) {
  return `${sessionId}:ebs`;
}

export async function storeSessionEbs(sessionId: string, data: EbsData): Promise<void> {
  await withStore("readwrite", (store) => store.put(data, buildSessionEbsKey(sessionId)));
}

export async function getSessionEbs(sessionId: string): Promise<EbsData | null> {
  return (await withStore("readonly", (store) => store.get(buildSessionEbsKey(sessionId)))) || null;
}

export async function deleteSessionEbs(sessionId: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(buildSessionEbsKey(sessionId)));
}

