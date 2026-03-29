"use client";

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';

import {
  createSession,
  getAnalysisMode,
  getStorageMode,
  updateSession,
} from '../../lib/sessionStorage';
import { storeSessionVideo } from '../../lib/videoStorage';

export default function UploadPage() {
  const router = useRouter();
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [practiceFile, setPracticeFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [draggingType, setDraggingType] = useState<'reference' | 'practice' | null>(null);
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordedPreviewUrl, setRecordedPreviewUrl] = useState<string | null>(null);
  const storageMode = getStorageMode();
  const analysisMode = getAnalysisMode();
  const liveVideoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (liveVideoRef.current && streamRef.current) {
      liveVideoRef.current.srcObject = streamRef.current;
    }
  }, [cameraReady, recorderOpen]);

  useEffect(() => {
    return () => {
      if (recordedPreviewUrl) {
        URL.revokeObjectURL(recordedPreviewUrl);
      }

      if (recordingTimerRef.current) {
        window.clearInterval(recordingTimerRef.current);
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [recordedPreviewUrl]);

  const handleFileChange = (type: 'reference' | 'practice') => (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      if (type === 'reference') setReferenceFile(e.target.files[0]);
      else setPracticeFile(e.target.files[0]);
    }
  };

  const handleDrop = (type: 'reference' | 'practice') => (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDraggingType(null);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile.type.startsWith('video/')) {
        if (type === 'reference') setReferenceFile(droppedFile);
        else setPracticeFile(droppedFile);
      }
    }
  };

  const getSupportedRecordingMimeType = () => {
    if (typeof MediaRecorder === 'undefined') {
      return null;
    }

    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];

    return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
  };

  const closeRecorder = () => {
    if (recordingTimerRef.current) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    setCameraReady(false);
    setRecording(false);
    setRecordingSeconds(0);
    setRecorderOpen(false);
  };

  const openRecorder = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('This browser does not support in-app video recording.');
      setRecorderOpen(true);
      return;
    }

    try {
      setRecorderOpen(true);
      setCameraError(null);
      setCameraReady(false);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: true,
      });

      streamRef.current = stream;
      if (liveVideoRef.current) {
        liveVideoRef.current.srcObject = stream;
      }
      setCameraReady(true);
    } catch (error) {
      console.error(error);
      setCameraError('Camera or microphone access was blocked. Please allow access and try again.');
    }
  };

  const startRecording = () => {
    const stream = streamRef.current;
    if (!stream) {
      setCameraError('Camera is not ready yet.');
      return;
    }

    const mimeType = getSupportedRecordingMimeType();
    if (mimeType === null) {
      setCameraError('Recording is not supported in this browser.');
      return;
    }

    try {
      recordedChunksRef.current = [];
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const blobType = recorder.mimeType || 'video/webm';
        const blob = new Blob(recordedChunksRef.current, { type: blobType });
        const extension = blobType.includes('mp4') ? 'mp4' : 'webm';
        const file = new File([blob], `tempoflow-practice-${Date.now()}.${extension}`, {
          type: blobType,
        });

        if (recordedPreviewUrl) {
          URL.revokeObjectURL(recordedPreviewUrl);
        }

        setPracticeFile(file);
        setRecordedPreviewUrl(URL.createObjectURL(blob));
        setRecording(false);

        if (recordingTimerRef.current) {
          window.clearInterval(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingSeconds((value) => value + 1);
      }, 1000);
    } catch (error) {
      console.error(error);
      setCameraError('Failed to start recording. Try again or upload a file instead.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  };

  const validateFile = (file: File, type: 'reference' | 'practice') => {
    if (!file.type.startsWith('video/')) {
      throw new Error(`Please choose a valid video file for ${type}.`);
    }

    const maxMb = storageMode === 'aws' ? 100 : 300;
    if (file.size > maxMb * 1024 * 1024) {
      throw new Error(`${type === 'reference' ? 'Reference' : 'Practice'} video is larger than ${maxMb} MB.`);
    }
  };

  const uploadToAwsIfNeeded = async (file: File, type: 'reference' | 'practice') => {
    if (storageMode !== 'aws') {
      return;
    }

    setMessage(`Preparing cloud upload for ${type}...`);
    const response = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, contentType: file.type }),
    });

    if (!response.ok) {
      throw new Error(`Failed to prepare cloud upload for ${type}.`);
    }

    const { url, fields } = await response.json();
    setMessage(`Uploading ${type} to cloud...`);

    const formData = new FormData();
    Object.entries(fields).forEach(([key, value]) => {
      formData.append(key, value as string);
    });
    formData.append('file', file);

    const uploadResponse = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!uploadResponse.ok) {
      throw new Error(`Upload failed for ${type}.`);
    }
  };

  const handleUpload = async () => {
    if (!referenceFile || !practiceFile) return;

    setUploading(true);
    setMessage('Preparing your session...');
    let createdSessionId: string | null = null;

    try {
      validateFile(referenceFile, 'reference');
      validateFile(practiceFile, 'practice');

      const session = createSession({
        referenceName: referenceFile.name,
        practiceName: practiceFile.name,
        referenceSize: referenceFile.size,
        practiceSize: practiceFile.size,
        storageMode,
        analysisMode,
      });
      createdSessionId = session.id;

      setMessage('Saving videos to this device...');
      await Promise.all([
        storeSessionVideo(session.id, 'reference', referenceFile),
        storeSessionVideo(session.id, 'practice', practiceFile),
      ]);

      await uploadToAwsIfNeeded(referenceFile, 'reference');
      await uploadToAwsIfNeeded(practiceFile, 'practice');

      updateSession(session.id, {
        status: 'analyzing',
        ebsStatus: 'processing',
        ebsErrorMessage: undefined,
        errorMessage: undefined,
      });
      setMessage('Session ready. Opening EBS session...');
      router.push(`/analysis?session=${session.id}`);
    } catch (error: unknown) {
      const typedError = error instanceof Error ? error : new Error('An unexpected error occurred.');
      console.error(error);
      if (createdSessionId) {
        updateSession(createdSessionId, { status: 'error', errorMessage: typedError.message });
      }
      setMessage(typedError.message);
    } finally {
      setUploading(false);
    }
  };

  const UploadZone = ({ type, file }: {
    type: 'reference' | 'practice', 
    file: File | null,
  }) => (
    <div
      onDrop={handleDrop(type)}
      onDragOver={(e) => { e.preventDefault(); setDraggingType(type); }}
      onDragLeave={() => setDraggingType(null)}
      className={`
        relative border-2 border-dashed rounded-[28px] p-8 text-center transition-all bg-sky-50/60
        ${draggingType === type ? 'border-sky-500 bg-sky-100' : 'border-sky-100 hover:border-sky-300'}
        ${file ? 'bg-white border-solid border-sky-300 shadow-sm' : ''}
      `}
    >
      <input
        type="file"
        accept="video/*"
        onChange={handleFileChange(type)}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        disabled={uploading}
      />
      
      {!file ? (
        <div className="space-y-3">
          <div className="w-12 h-12 mx-auto bg-white rounded-2xl flex items-center justify-center border border-sky-100">
            <svg className="w-6 h-6 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </div>
          <div>
            <p className="text-base font-medium text-slate-900">Add {type} video</p>
            <p className="mt-1 text-xs text-slate-500">Drop file or click to browse</p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="w-12 h-12 mx-auto bg-sky-100 rounded-2xl flex items-center justify-center">
            <svg className="w-6 h-6 text-sky-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-slate-900 truncate px-2">{file.name}</p>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-sky-50">
      <div className="fixed top-0 left-0 right-0 bg-white/85 backdrop-blur-md border-b border-sky-100 z-10">
        <div className="flex items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center">
            <Image 
              src="/logo.png" 
              alt="TempoFlow" 
              width={140} 
              height={40}
              className="rounded"
              priority
            />
          </Link>
          <Link
            href="/dashboard"
            className="px-4 py-2 bg-gradient-to-r from-blue-500 to-cyan-400 text-white rounded-full text-sm font-medium hover:from-blue-600 hover:to-cyan-500 transition-all"
          >
            Dashboard
          </Link>
        </div>
      </div>

      <div className="flex flex-col items-center justify-center min-h-screen px-6 py-24 pt-28">
        <div className="w-full max-w-4xl space-y-8">
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-sky-600">TempoFlow EBS Session</p>
            <h1 className="mt-3 text-4xl font-bold text-slate-900 mb-2">Start with two videos</h1>
            <p className="text-slate-600">Upload the reference and your practice clip. We will open the beat-synced EBS session view automatically.</p>
            <div className="mt-4 inline-flex flex-wrap items-center justify-center gap-2 text-xs font-medium">
              <span className="rounded-full bg-white px-3 py-1 text-slate-700 border border-sky-100">
                Storage: {storageMode === 'aws' ? 'AWS + local backup' : 'Local-only'}
              </span>
              <span className="rounded-full bg-sky-50 px-3 py-1 text-sky-700 border border-sky-100">
                Analysis: {analysisMode === 'api' ? 'Local + API assist' : 'Local'}
              </span>
            </div>
          </div>

          <div className="rounded-[32px] border border-sky-100 bg-white px-6 py-5 text-sm text-slate-600 shadow-sm">
            {storageMode === 'aws'
              ? 'Videos are saved on this device first, then uploaded to cloud storage.'
              : 'Videos stay on this device for now so you can iterate locally without AWS setup. EBS processing happens after upload in the session page.'}
          </div>

          <div className="rounded-[32px] border border-sky-100 bg-white p-6 shadow-sm">
            <div className="mb-5">
              <h2 className="text-lg font-semibold text-slate-900">Upload clips</h2>
              <p className="mt-1 text-sm text-slate-600">This replaces the old analysis flow. New sessions open directly in the EBS viewer.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <p className="text-sm font-semibold text-sky-700 uppercase tracking-wider ml-1">Reference</p>
              <UploadZone type="reference" file={referenceFile} />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-semibold text-sky-700 uppercase tracking-wider ml-1">Your Practice</p>
              <UploadZone type="practice" file={practiceFile} />
            </div>
          </div>
          </div>

          {referenceFile && practiceFile && !uploading && (
            <button
              onClick={handleUpload}
              className="w-full py-4 text-xl font-semibold text-white bg-gradient-to-r from-sky-400 to-blue-600 rounded-full hover:opacity-95 transition-all active:scale-95 shadow-xl"
            >
              Open EBS Session
            </button>
          )}

          {message && (
            <div className={`
              text-center py-4 px-6 rounded-[28px] transition-all animate-in fade-in slide-in-from-bottom-2 border
              ${message.includes('✓') ? 'bg-green-50 text-green-700 border-green-100' : 'bg-white text-slate-700 font-medium border-sky-100'}
            `}>
              {message}
            </div>
          )}

          {uploading && (
            <div className="flex flex-col items-center justify-center gap-4 text-slate-600 rounded-[32px] border border-sky-100 bg-white py-8 shadow-sm">
              <div className="w-8 h-8 border-3 border-sky-100 border-t-sky-500 rounded-full animate-spin" />
              <p className="animate-pulse">Preparing your EBS session...</p>
            </div>
          )}

          <div className="rounded-[32px] border border-sky-100 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Film your practice in the app</h2>
                <p className="text-sm text-slate-600">
                  Keep the reference as an upload, then record a new practice take directly from your camera.
                </p>
              </div>
              <button
                onClick={recorderOpen ? closeRecorder : openRecorder}
                disabled={uploading}
                className="rounded-full bg-sky-600 px-5 py-3 text-sm font-medium text-white transition-all hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {recorderOpen ? 'Close Recorder' : 'Record Practice Video'}
              </button>
            </div>

            {recorderOpen && (
              <div className="mt-5 space-y-4">
                <div className="overflow-hidden rounded-3xl bg-gray-950">
                  {cameraReady ? (
                    <video
                      ref={liveVideoRef}
                      className="aspect-video w-full object-cover"
                      autoPlay
                      muted
                      playsInline
                    />
                  ) : (
                    <div className="flex aspect-video items-center justify-center px-6 text-center text-sm text-gray-300">
                      {cameraError ?? 'Requesting camera access...'}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  {!recording ? (
                    <button
                      onClick={startRecording}
                      disabled={!cameraReady || uploading}
                      className="rounded-full bg-slate-900 px-5 py-3 text-sm font-medium text-white transition-all hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Start Recording
                    </button>
                  ) : (
                    <button
                      onClick={stopRecording}
                      className="rounded-full bg-red-600 px-5 py-3 text-sm font-medium text-white transition-all hover:bg-red-700"
                    >
                      Stop Recording
                    </button>
                  )}

                  <span className="text-sm text-gray-600">
                    {recording ? `Recording... ${recordingSeconds}s` : 'Tip: keep your full body in frame.'}
                  </span>
                </div>

                {recordedPreviewUrl && !recording && (
                  <div className="space-y-3 rounded-2xl border border-gray-200 bg-gray-50 p-4">
                    <p className="text-sm font-medium text-gray-900">Latest recorded practice take</p>
                    <video
                      src={recordedPreviewUrl}
                      controls
                      className="aspect-video w-full rounded-2xl bg-black object-cover"
                    />
                    <p className="text-sm text-gray-600">
                      This take is already selected as your practice video for analysis.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
