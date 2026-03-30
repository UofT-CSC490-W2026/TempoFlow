import type { BodyPixComparisonResult } from "./bodyPix";

export const VISUAL_FEEDBACK_CACHE_VERSION = "2";

const DB_NAME = "TempoFlowVisualFeedback";
const STORE_NAME = "runs";
const DB_VERSION = 1;

export function buildVisualFeedbackKey(params: {
  sessionId: string;
  ebsFingerprint: string;
}): string {
  const { sessionId, ebsFingerprint } = params;
  return `${sessionId}:visual-feedback:${VISUAL_FEEDBACK_CACHE_VERSION}:${ebsFingerprint}`;
}

type StoredRecord = {
  version: 1;
  savedAt: string;
  result: BodyPixComparisonResult;
};

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

export async function getVisualFeedbackRun(key: string): Promise<BodyPixComparisonResult | null> {
  const row = (await withStore("readonly", (store) => store.get(key))) as StoredRecord | undefined;
  if (!row || row.version !== 1 || !row.result) return null;
  return row.result;
}

export async function storeVisualFeedbackRun(
  key: string,
  result: BodyPixComparisonResult,
): Promise<void> {
  const payload: StoredRecord = {
    version: 1,
    savedAt: new Date().toISOString(),
    result,
  };
  await withStore("readwrite", (store) => store.put(payload, key));
}
