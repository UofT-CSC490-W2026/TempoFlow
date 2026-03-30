"use client";

export type SessionStatus = 'uploaded' | 'analyzing' | 'analyzed' | 'error';
export type StorageMode = 'local' | 'api' | 'aws';
export type AnalysisMode = 'local' | 'api';
export type EbsStatus = 'idle' | 'processing' | 'paused' | 'ready' | 'error';

export interface AnalysisScores {
  overall: number;
  timing: number;
  positioning: number;
  smoothness: number;
  energy: number;
}

export interface AnalysisSegment {
  id: string;
  label: string;
  focusArea: string;
  startSec: number;
  endSec: number;
  score: number;
}

export interface AnalysisInsight {
  id: string;
  tone: 'positive' | 'focus' | 'tip';
  title: string;
  body: string;
  timestampSec?: number;
}

export interface AnalysisSummary {
  scores: AnalysisScores;
  strongestArea: string;
  focusArea: string;
  timingOffsetMs: number;
  durationSec: number;
  segments: AnalysisSegment[];
  insights: AnalysisInsight[];
  generatedAt: string;
}

export interface Sam3Result {
  provider: 'modal';
  prompt: string;
  generatedAt: string;
}

export interface EbsSessionMeta {
  segmentCount: number;
  estimatedBpm?: number;
  segmentationMode?: string;
  sharedDurationSec: number;
  generatedAt: string;
  processingStartedAt?: string;
  finalScore?: number;
  postProcessStatus?: 'idle' | 'processing' | 'paused' | 'ready' | 'error';
  yoloReadySegments?: number;
  visualReadySegments?: number;
  geminiReadySegments?: number;
  geminiTotalSegments?: number;
}

export interface TempoFlowSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  storageMode: StorageMode;
  analysisMode: AnalysisMode;
  status: SessionStatus;
  ebsStatus: EbsStatus;
  referenceName: string;
  practiceName: string;
  referenceSize: number;
  practiceSize: number;
  ebsMeta?: EbsSessionMeta;
  ebsErrorMessage?: string;
  analysis?: AnalysisSummary;
  sam3Result?: Sam3Result;
  errorMessage?: string;
}

const SESSIONS_KEY = 'tempoflow.sessions';
const CURRENT_SESSION_KEY = 'tempoflow.currentSessionId';
const SESSIONS_CHANGED_EVENT = 'tempoflow:sessions-changed';

function canUseStorage() {
  return typeof window !== 'undefined';
}

function readSessions(): TempoFlowSession[] {
  if (!canUseStorage()) return [];

  try {
    const raw = window.localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as TempoFlowSession[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSessions(sessions: TempoFlowSession[]) {
  if (!canUseStorage()) return;
  window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  window.dispatchEvent(new CustomEvent(SESSIONS_CHANGED_EVENT));
}

function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getStorageMode(): StorageMode {
  return (process.env.NEXT_PUBLIC_APP_STORAGE_MODE as StorageMode | undefined) ?? 'local';
}

export function getAnalysisMode(): AnalysisMode {
  return (process.env.NEXT_PUBLIC_APP_ANALYSIS_MODE as AnalysisMode | undefined) ?? 'local';
}

export function createSession(input: {
  referenceName: string;
  practiceName: string;
  referenceSize: number;
  practiceSize: number;
  storageMode?: StorageMode;
  analysisMode?: AnalysisMode;
}): TempoFlowSession {
  const timestamp = new Date().toISOString();

  const session: TempoFlowSession = {
    id: makeId(),
    createdAt: timestamp,
    updatedAt: timestamp,
    storageMode: input.storageMode ?? getStorageMode(),
    analysisMode: input.analysisMode ?? getAnalysisMode(),
    status: 'uploaded',
    ebsStatus: 'idle',
    referenceName: input.referenceName,
    practiceName: input.practiceName,
    referenceSize: input.referenceSize,
    practiceSize: input.practiceSize,
  };

  const sessions = readSessions();
  writeSessions([session, ...sessions]);
  setCurrentSessionId(session.id);
  return session;
}

export function getSessions(): TempoFlowSession[] {
  return readSessions().sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function getSession(sessionId: string): TempoFlowSession | null {
  return getSessions().find((session) => session.id === sessionId) ?? null;
}

export function updateSession(sessionId: string, updates: Partial<TempoFlowSession>): TempoFlowSession | null {
  const sessions = readSessions();
  let updatedSession: TempoFlowSession | null = null;

  const nextSessions = sessions.map((session) => {
    if (session.id !== sessionId) return session;

    updatedSession = {
      ...session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    return updatedSession;
  });

  writeSessions(nextSessions);
  return updatedSession;
}

export function deleteSessionMetadata(sessionId: string) {
  const sessions = readSessions().filter((session) => session.id !== sessionId);
  writeSessions(sessions);

  if (getCurrentSessionId() === sessionId) {
    window.localStorage.removeItem(CURRENT_SESSION_KEY);
  }
}

export function setCurrentSessionId(sessionId: string) {
  if (!canUseStorage()) return;
  window.localStorage.setItem(CURRENT_SESSION_KEY, sessionId);
}

export function getCurrentSessionId(): string | null {
  if (!canUseStorage()) return null;
  return window.localStorage.getItem(CURRENT_SESSION_KEY);
}

export function subscribeSessions(listener: () => void): () => void {
  if (!canUseStorage()) return () => {};

  window.addEventListener(SESSIONS_CHANGED_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(SESSIONS_CHANGED_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}
