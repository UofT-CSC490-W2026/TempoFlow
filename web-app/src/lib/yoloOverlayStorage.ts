"use client";

const DB_NAME = 'TempoFlowYoloOverlaysV2';
const STORE_NAME = 'frames';
const DB_VERSION = 1;

export type YoloOverlayRole = 'reference' | 'practice';

type Manifest = {
  version: 1;
  role: YoloOverlayRole;
  frameCount: number;
  createdAt: string;
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

function buildFrameKey(sessionId: string, role: YoloOverlayRole, index: number) {
  return `${sessionId}:${role}:frame:${index}`;
}

function buildManifestKey(sessionId: string, role: YoloOverlayRole) {
  return `${sessionId}:${role}:manifest`;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, base64] = dataUrl.split(',');
  const mimeMatch = meta?.match(/data:([^;]+);base64/);
  const mime = mimeMatch?.[1] ?? 'image/jpeg';
  const binary = atob(base64 ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function withStore(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => void,
): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    callback(store);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

export async function saveYoloOverlayFrames(params: {
  sessionId: string;
  role: YoloOverlayRole;
  framesDataUrl: string[];
}): Promise<void> {
  const { sessionId, role, framesDataUrl } = params;

  await withStore('readwrite', (store) => {
    const manifest: Manifest = {
      version: 1,
      role,
      frameCount: framesDataUrl.length,
      createdAt: new Date().toISOString(),
    };
    store.put(manifest, buildManifestKey(sessionId, role));

    for (let i = 0; i < framesDataUrl.length; i++) {
      store.put(dataUrlToBlob(framesDataUrl[i] ?? ''), buildFrameKey(sessionId, role, i));
    }
  });
}

export async function loadYoloOverlayFrames(params: {
  sessionId: string;
  role: YoloOverlayRole;
}): Promise<string[] | null> {
  const { sessionId, role } = params;
  const db = await openDB();

  const manifest = await new Promise<Manifest | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(buildManifestKey(sessionId, role));
    req.onsuccess = () => resolve((req.result as Manifest | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });

  if (!manifest || manifest.frameCount <= 0) {
    db.close();
    return null;
  }

  const blobs = await new Promise<(Blob | null)[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const results: (Blob | null)[] = Array.from({ length: manifest.frameCount }, () => null);
    let done = 0;

    for (let i = 0; i < manifest.frameCount; i++) {
      const req = store.get(buildFrameKey(sessionId, role, i));
      req.onsuccess = () => {
        results[i] = (req.result as Blob | undefined) ?? null;
        done++;
        if (done === manifest.frameCount) resolve(results);
      };
      req.onerror = () => reject(req.error);
    }
  });

  db.close();

  const urls: string[] = [];
  for (const blob of blobs) {
    if (!blob) return null;
    urls.push(URL.createObjectURL(blob));
  }
  return urls;
}

