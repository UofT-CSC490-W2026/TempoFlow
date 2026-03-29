import type { GeminiSegmentResult } from "./geminiFeedbackTypes";

/**
 * Bump when the move-feedback request shape or client priors logic changes enough to invalidate old cache rows.
 */
export const GEMINI_FEEDBACK_CACHE_VERSION = "1";

const DB_NAME = "TempoFlowGeminiFeedback";
const STORE_NAME = "segments";
const DB_VERSION = 1;

/** Fast stable fingerprint for EBS JSON (invalidates cache when analysis changes). */
export function hashEbsData(ebs: unknown): string {
  const s = JSON.stringify(ebs);
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = Math.imul(h, 33) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

export function buildFeedbackSegmentKey(params: {
  sessionId: string;
  segmentIndex: number;
  burnInLabels: boolean;
  includeAudio: boolean;
  ebsFingerprint: string;
}): string {
  const { sessionId, segmentIndex, burnInLabels, includeAudio, ebsFingerprint } = params;
  return `${sessionId}:gemini-feedback:${GEMINI_FEEDBACK_CACHE_VERSION}:${segmentIndex}:b${burnInLabels ? 1 : 0}:a${includeAudio ? 1 : 0}:${ebsFingerprint}`;
}

type StoredRecord = { version: 1; savedAt: string; result: GeminiSegmentResult };

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

export async function getFeedbackSegment(key: string): Promise<GeminiSegmentResult | null> {
  const row = (await withStore("readonly", (store) => store.get(key))) as StoredRecord | undefined;
  if (!row || row.version !== 1 || !row.result) return null;
  return row.result;
}

export async function storeFeedbackSegment(key: string, result: GeminiSegmentResult): Promise<void> {
  const payload: StoredRecord = {
    version: 1,
    savedAt: new Date().toISOString(),
    result,
  };
  await withStore("readwrite", (store) => store.put(payload, key));
}

export async function deleteFeedbackSegment(key: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(key));
}
