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
  const stepPanelMinHeightClass = 'min-h-[540px]';
  const stepPanelBodyMinHeightClass = 'min-h-[444px]';
  const [flowStep, setFlowStep] = useState<'intro' | 'reference' | 'practice' | 'launching'>('intro');
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
  const [recorderTarget, setRecorderTarget] = useState<'reference' | 'practice'>('practice');
  const [introFadingOut, setIntroFadingOut] = useState(false);
  const [pauseReferenceAutoAdvance, setPauseReferenceAutoAdvance] = useState(false);
  const [stepTransitionDirection, setStepTransitionDirection] = useState<'forward' | 'backward'>('forward');
  const [stepAnimationKey, setStepAnimationKey] = useState(0);
  const storageMode = getStorageMode();
  const analysisMode = getAnalysisMode();
  const liveVideoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const launchStartedRef = useRef(false);

  const formatFileSize = (bytes: number) => {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  };

  const transitionBetweenUploadSteps = (
    nextStep: 'reference' | 'practice',
    direction: 'forward' | 'backward',
  ) => {
    setStepTransitionDirection(direction);
    setStepAnimationKey((value) => value + 1);
    setFlowStep(nextStep);
  };

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

  useEffect(() => {
    if (flowStep !== 'intro') return;
    setIntroFadingOut(false);
    const fadeTimeoutId = window.setTimeout(() => {
      setIntroFadingOut(true);
    }, 900);
    const timeoutId = window.setTimeout(() => {
      setStepTransitionDirection('forward');
      setFlowStep('reference');
    }, 1600);
    return () => {
      window.clearTimeout(fadeTimeoutId);
      window.clearTimeout(timeoutId);
    };
  }, [flowStep]);

  useEffect(() => {
    if (flowStep !== 'reference' || !referenceFile) return;
    if (pauseReferenceAutoAdvance) return;
    if (recorderOpen) closeRecorder();
    const timeoutId = window.setTimeout(() => {
      setMessage('');
      transitionBetweenUploadSteps('practice', 'forward');
    }, 750);
    return () => window.clearTimeout(timeoutId);
  }, [flowStep, pauseReferenceAutoAdvance, referenceFile, recorderOpen]);

  useEffect(() => {
    if (flowStep !== 'practice' || !practiceFile) return;
    if (recorderOpen) closeRecorder();
    const timeoutId = window.setTimeout(() => {
      setFlowStep('launching');
    }, 750);
    return () => window.clearTimeout(timeoutId);
  }, [flowStep, practiceFile, recorderOpen]);

  const handleFileChange = (type: 'reference' | 'practice') => (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      if (type === 'reference') {
        setReferenceFile(e.target.files[0]);
        setPauseReferenceAutoAdvance(false);
      } else {
        setPracticeFile(e.target.files[0]);
      }
      setMessage('');
    }
  };

  const handleDrop = (type: 'reference' | 'practice') => (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDraggingType(null);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile.type.startsWith('video/')) {
        if (type === 'reference') {
          setReferenceFile(droppedFile);
          setPauseReferenceAutoAdvance(false);
        } else {
          setPracticeFile(droppedFile);
        }
        setMessage('');
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

  const openRecorder = async (target: 'reference' | 'practice') => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setRecorderTarget(target);
      setCameraError('This browser does not support in-app video recording.');
      setRecorderOpen(true);
      return;
    }

    try {
      setRecorderTarget(target);
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
        const file = new File([blob], `tempoflow-${recorderTarget}-${Date.now()}.${extension}`, {
          type: blobType,
        });

        if (recordedPreviewUrl) {
          URL.revokeObjectURL(recordedPreviewUrl);
        }

        if (recorderTarget === 'reference') {
          setReferenceFile(file);
          setPauseReferenceAutoAdvance(false);
        } else {
          setPracticeFile(file);
        }
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
      launchStartedRef.current = false;
      setFlowStep('practice');
    } finally {
      setUploading(false);
    }
  };

  useEffect(() => {
    if (flowStep !== 'launching' || !referenceFile || !practiceFile || uploading) return;
    if (launchStartedRef.current) return;
    launchStartedRef.current = true;
    const timeoutId = window.setTimeout(() => {
      void handleUpload();
    }, 700);
    return () => window.clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowStep, referenceFile, practiceFile, uploading]);

  const UploadZone = ({ type, file }: {
    type: 'reference' | 'practice', 
    file: File | null,
  }) => {
    const label = type === 'reference' ? 'Reference' : 'Practice';
    const actionLabel = type === 'reference' ? 'Choose reference' : 'Choose practice';

    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-sky-700">{label}</p>
          {file ? (
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
              Ready
            </span>
          ) : null}
        </div>

        <div
          onDrop={handleDrop(type)}
          onDragOver={(e) => { e.preventDefault(); setDraggingType(type); }}
          onDragLeave={() => setDraggingType(null)}
          className={`
            group relative overflow-hidden rounded-[28px] border p-8 transition-all
            ${stepPanelMinHeightClass}
            ${draggingType === type ? 'border-sky-400 bg-sky-100/80 shadow-lg shadow-sky-200/60' : 'border-sky-100 bg-white/90 hover:border-sky-300 hover:shadow-lg hover:shadow-sky-100/80'}
            ${file ? 'border-sky-200 bg-gradient-to-br from-white to-sky-50/70' : ''}
          `}
        >
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(14,165,233,0.12),_transparent_48%)] opacity-70" />
          <input
            type="file"
            accept="video/*"
            onChange={handleFileChange(type)}
            className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
            disabled={uploading}
          />

          {!file ? (
            <div className={`relative flex h-full ${stepPanelBodyMinHeightClass} flex-col items-center justify-center text-center`}>
              <div className="flex h-16 w-16 items-center justify-center rounded-3xl border border-sky-100 bg-white text-sky-500 shadow-sm transition-transform group-hover:scale-105">
                <svg className="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 5v14M19 12H5" />
                </svg>
              </div>
              <p className="mt-6 text-2xl font-semibold tracking-tight text-slate-900">{actionLabel}</p>
              <p className="mt-2 max-w-xs text-sm text-slate-500">Drop video or click to browse</p>
            </div>
          ) : (
            <div className={`relative flex h-full ${stepPanelBodyMinHeightClass} flex-col justify-between`}>
              <div className="flex h-14 w-14 items-center justify-center rounded-3xl bg-sky-100 text-sky-700">
                <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>

              <div className="space-y-3">
                <p className="text-xl font-semibold tracking-tight text-slate-900 break-words">{file.name}</p>
                <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-500">
                  <span className="rounded-full bg-slate-100 px-3 py-1">{formatFileSize(file.size)}</span>
                  <span className="rounded-full bg-slate-100 px-3 py-1">{file.type || 'video file'}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const stepLabel = flowStep === 'practice' ? 'Practice' : 'Reference';
  const activeFile = flowStep === 'practice' ? practiceFile : referenceFile;
  const isReferenceStep = flowStep === 'reference';

  const goToPreviousStep = () => {
    setMessage('');
    if (recorderOpen) closeRecorder();

    if (flowStep === 'practice') {
      setPracticeFile(null);
      setPauseReferenceAutoAdvance(true);
      transitionBetweenUploadSteps('reference', 'backward');
      return;
    }

    if (flowStep === 'reference') {
      setReferenceFile(null);
      setStepTransitionDirection('backward');
      setStepAnimationKey((value) => value + 1);
      setFlowStep('intro');
    }
  };

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f7fbff_0%,#edf7ff_34%,#f7fbff_100%)]">
      <div className="sticky top-0 left-0 right-0 z-10 border-b border-sky-100/80 bg-white/88 backdrop-blur-md">
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

      <div className="px-6 py-14 md:py-20">
        <div className="mx-auto w-full max-w-5xl">
          {flowStep === 'intro' ? (
            <div
              className={`overflow-hidden rounded-[44px] border border-sky-100/80 bg-white/80 shadow-[0_24px_80px_rgba(14,165,233,0.12)] backdrop-blur-sm transition-all duration-700 ${
                introFadingOut ? 'scale-[0.985] opacity-0' : 'scale-100 opacity-100'
              }`}
            >
              <div className="relative px-8 py-[4.5rem] text-center md:px-14 md:py-24">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(14,165,233,0.14),_transparent_50%),linear-gradient(135deg,rgba(255,255,255,0.96),rgba(237,247,255,0.92))]" />
                <div className="relative">
                  <p className="text-xs font-semibold uppercase tracking-[0.32em] text-sky-600">Create Session</p>
                  <h1 className="mt-5 text-5xl font-bold tracking-tight text-slate-950 md:text-6xl">Compare two clips</h1>
                </div>
              </div>
            </div>
          ) : flowStep === 'launching' ? (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-700 overflow-hidden rounded-[44px] border border-sky-100/80 bg-white/82 shadow-[0_24px_80px_rgba(14,165,233,0.12)] backdrop-blur-sm">
              <div className="relative px-8 py-[4.5rem] text-center md:px-14 md:py-24">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(14,165,233,0.14),_transparent_50%),linear-gradient(135deg,rgba(255,255,255,0.96),rgba(237,247,255,0.92))]" />
                <div className="relative mx-auto max-w-2xl">
                  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-sky-100 bg-white shadow-sm">
                    <div className="h-8 w-8 rounded-full border-2 border-sky-100 border-t-sky-500 animate-spin" />
                  </div>
                  <p className="mt-6 text-xs font-semibold uppercase tracking-[0.32em] text-sky-600">Opening</p>
                  <h1 className="mt-4 text-4xl font-bold tracking-tight text-slate-950 md:text-5xl">EBS Studio Session</h1>
                  <p className="mt-4 text-base leading-7 text-slate-600">{message || 'Preparing your clips...'}</p>
                  <div className="mt-8 flex flex-wrap justify-center gap-3 text-sm text-slate-500">
                    {referenceFile ? <span className="rounded-full bg-slate-100 px-4 py-2">{referenceFile.name}</span> : null}
                    {practiceFile ? <span className="rounded-full bg-slate-100 px-4 py-2">{practiceFile.name}</span> : null}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div
              key={`${flowStep}-${stepAnimationKey}`}
              data-testid="upload-step-card"
              className={`rounded-[40px] border border-sky-100/80 bg-white/82 p-6 shadow-[0_24px_80px_rgba(14,165,233,0.1)] backdrop-blur-sm md:p-8 ${
                stepTransitionDirection === 'forward' ? 'upload-step-enter-forward' : 'upload-step-enter-backward'
              }`}
            >
              <div className="mb-8 flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.32em] text-sky-600">
                    {isReferenceStep ? 'Step 1' : 'Step 2'}
                  </p>
                  <h1 className="mt-3 text-4xl font-bold tracking-tight text-slate-950 md:text-5xl">
                    {isReferenceStep ? 'Choose a reference clip' : 'Add your practice clip'}
                  </h1>
                </div>
                <div className="flex items-center gap-3">
                  {isReferenceStep && referenceFile && pauseReferenceAutoAdvance ? (
                    <button
                      type="button"
                      onClick={() => {
                        setPauseReferenceAutoAdvance(false);
                        transitionBetweenUploadSteps('practice', 'forward');
                      }}
                      className="rounded-full bg-slate-950 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-slate-800"
                    >
                      Continue
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={goToPreviousStep}
                    className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition-all hover:border-slate-300 hover:text-slate-900"
                  >
                    Back
                  </button>
                </div>
              </div>

              <div className="grid items-stretch gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="flex h-full flex-col">
                  <UploadZone type={isReferenceStep ? 'reference' : 'practice'} file={activeFile} />
                </div>

                <div className={`flex h-full ${stepPanelMinHeightClass} flex-col rounded-[32px] border border-slate-200/80 bg-slate-50/80 p-5`}>
                  <div className="flex items-start gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-sky-100 text-sky-700">
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold tracking-tight text-slate-950">
                        Record {isReferenceStep ? 'reference' : 'practice'}
                      </h2>
                      <p className="mt-1 text-sm text-slate-500">Use your camera instead of uploading.</p>
                    </div>
                  </div>

                  <button
                    onClick={() =>
                      recorderOpen && recorderTarget === (isReferenceStep ? 'reference' : 'practice')
                        ? closeRecorder()
                        : openRecorder(isReferenceStep ? 'reference' : 'practice')
                    }
                    disabled={uploading}
                    className={`mt-5 inline-flex w-full items-center justify-center rounded-full px-5 py-3.5 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
                      recorderOpen && recorderTarget === (isReferenceStep ? 'reference' : 'practice')
                        ? 'bg-slate-950 text-white'
                        : 'bg-sky-600 text-white hover:bg-sky-700'
                    }`}
                  >
                    {recorderOpen && recorderTarget === (isReferenceStep ? 'reference' : 'practice')
                      ? 'Close Recorder'
                      : `Record ${stepLabel}`}
                  </button>

                  {recorderOpen && recorderTarget === (isReferenceStep ? 'reference' : 'practice') ? (
                    <div className="mt-5 flex flex-1 flex-col space-y-4">
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
                            className="rounded-full bg-slate-950 px-5 py-3 text-sm font-medium text-white transition-all hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
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
                        <span className="text-sm text-slate-500">
                          {recording ? `Recording... ${recordingSeconds}s` : `${stepLabel} camera ready`}
                        </span>
                      </div>

                      {recordedPreviewUrl && !recording ? (
                        <video
                          src={recordedPreviewUrl}
                          controls
                          className="aspect-video w-full rounded-2xl bg-black object-cover"
                        />
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-5 flex flex-1 rounded-3xl bg-transparent" />
                  )}
                </div>
              </div>

              {message && !uploading ? (
                <div className="mt-6 rounded-3xl border border-red-100 bg-red-50 px-5 py-4 text-sm text-red-700">
                  {message}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
