export type OverlayType =
  | "yolo"
  | "movenet"
  | "fastsam"
  | "yolo-pose-arms"
  | "yolo-pose-legs";
export type OverlaySide = "reference" | "practice";

export type OverlayArtifact = {
  version: 1;
  type: OverlayType;
  side: OverlaySide;
  fps: number;
  width: number;
  height: number;
  frameCount: number;
  createdAt: string;
  // One of:
  // - frames: per-frame transparent images (legacy + browser precompute)
  // - video: a transparent overlay video (python precompute)
  frames?: Array<string | Blob>;
  video?: Blob;
  videoMime?: string;
  meta?: Record<string, unknown>;
};

const DB_NAME = "TempoFlowOverlays";
const STORE_NAME = "overlayArtifacts";
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

export function buildOverlayKey(params: {
  sessionId: string;
  type: OverlayType;
  side: OverlaySide;
  fps: number;
  variant?: string;
}) {
  const { sessionId, type, side, fps, variant } = params;
  return `${sessionId}:overlay:${type}:${side}:${fps}:${variant ?? "default"}`;
}

export async function storeSessionOverlay(key: string, artifact: OverlayArtifact): Promise<void> {
  await withStore("readwrite", (store) => store.put(artifact, key));
}

export async function getSessionOverlay(key: string): Promise<OverlayArtifact | null> {
  return (await withStore("readonly", (store) => store.get(key))) || null;
}

export async function deleteSessionOverlay(key: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(key));
}

