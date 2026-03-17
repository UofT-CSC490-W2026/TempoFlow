"use client";

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
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

      updateSession(session.id, { status: 'analyzing' });
      setMessage('Session ready. Opening analysis...');
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
        relative border-2 border-dashed rounded-3xl p-8 text-center transition-all
        ${draggingType === type ? 'border-purple-500 bg-purple-50' : 'border-gray-200 hover:border-gray-300'}
        ${file ? 'bg-gray-50 border-solid border-purple-200' : ''}
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
          <div className="w-12 h-12 mx-auto bg-gray-100 rounded-2xl flex items-center justify-center">
            <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </div>
          <div>
            <p className="text-base font-medium text-gray-900">Add {type} video</p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="w-12 h-12 mx-auto bg-purple-100 rounded-2xl flex items-center justify-center">
            <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-900 truncate px-2">{file.name}</p>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <div className="fixed top-0 left-0 right-0 bg-white/80 backdrop-blur-md border-b border-gray-100 z-10">
        <div className="flex items-center justify-between px-6 py-4">
          <Link href="/" className="text-2xl font-bold text-gray-900">
            TempoFlow
          </Link>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-col items-center justify-center min-h-screen px-6 py-24">
        <div className="w-full max-w-2xl space-y-8">
          {/* Title */}
          <div className="text-center">
            <h1 className="text-4xl font-bold text-gray-900 mb-2">Sync Your Session</h1>
            <p className="text-gray-600">Upload the reference and your practice video</p>
            <div className="mt-4 inline-flex flex-wrap items-center justify-center gap-2 text-xs font-medium">
              <span className="rounded-full bg-gray-100 px-3 py-1 text-gray-700">
                Storage: {storageMode === 'aws' ? 'AWS + local backup' : 'Local-only'}
              </span>
              <span className="rounded-full bg-purple-50 px-3 py-1 text-purple-700">
                Analysis: {analysisMode === 'api' ? 'Local + API assist' : 'Local'}
              </span>
            </div>
          </div>

          <div className="rounded-3xl border border-gray-200 bg-gray-50 px-5 py-4 text-sm text-gray-600">
            {storageMode === 'aws'
              ? 'Videos are saved on this device first, then uploaded to cloud storage.'
              : 'Videos stay on this device for now so you can iterate locally without AWS setup.'}
          </div>

          {/* Dual Upload Area */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <p className="text-sm font-semibold text-gray-400 uppercase tracking-wider ml-1">Reference</p>
              <UploadZone type="reference" file={referenceFile} />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-semibold text-gray-400 uppercase tracking-wider ml-1">Your Practice</p>
              <UploadZone type="practice" file={practiceFile} />
            </div>
          </div>

          {/* Upload Button */}
          {referenceFile && practiceFile && !uploading && (
            <button
              onClick={handleUpload}
              className="w-full py-4 text-xl font-semibold text-white bg-gray-900 rounded-full hover:bg-gray-800 transition-all active:scale-95 shadow-xl"
            >
              Analyze Locally
            </button>
          )}

          {/* Status Message */}
          {message && (
            <div className={`
              text-center py-4 px-6 rounded-3xl transition-all animate-in fade-in slide-in-from-bottom-2
              ${message.includes('✓') ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-700 font-medium'}
            `}>
              {message}
            </div>
          )}

          {/* Loading State */}
          {uploading && (
            <div className="flex flex-col items-center justify-center gap-4 text-gray-600">
              <div className="w-8 h-8 border-3 border-gray-200 border-t-purple-600 rounded-full animate-spin" />
              <p className="animate-pulse">Preparing your local analysis...</p>
            </div>
          )}

          <div className="rounded-3xl border border-gray-200 bg-white p-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Film your practice in the app</h2>
                <p className="text-sm text-gray-600">
                  Keep the reference as an upload, then record a new practice take directly from your camera.
                </p>
              </div>
              <button
                onClick={recorderOpen ? closeRecorder : openRecorder}
                disabled={uploading}
                className="rounded-full bg-purple-600 px-5 py-3 text-sm font-medium text-white transition-all hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-60"
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
                      className="rounded-full bg-gray-900 px-5 py-3 text-sm font-medium text-white transition-all hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
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
