import React, { useRef, useEffect, useState, useCallback } from 'react';
import { generateBodyPixOverlayFrames } from "../../lib/bodyPixOverlayGenerator";

interface OverlayArtifact {
  fps: number;
  frames: (string | Blob)[];
  width: number;
  height: number;
}

interface DifferenceViewerProps {
  referenceVideoUrl: string;
  userVideoUrl: string;
  ebsData?: any;
}

export function DifferenceViewer({ 
  referenceVideoUrl, 
  userVideoUrl, 
  ebsData 
}: DifferenceViewerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  
  // State for AI-generated artifacts
  const [refArtifact, setRefArtifact] = useState<OverlayArtifact | null>(null);
  const [userArtifact, setUserArtifact] = useState<OverlayArtifact | null>(null);
  
  // UI State
  const [status, setStatus] = useState<string>("Initializing...");
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  // 1. Internal Generation Logic
  const runGeneration = useCallback(async () => {
    if (isProcessing || (refArtifact && userArtifact)) return;
    
    setIsProcessing(true);
    try {
      // Process Instructor (Reference)
      setStatus("Extracting Instructor Ghost...");
      // @ts-ignore - Assuming global or imported utility
      const ref = await generateBodyPixOverlayFrames({
        videoUrl: referenceVideoUrl,
        fps: 12,
        opacity: 0.68,
        onProgress: (c: number, t: number) => setStatus(`Ghosting Instructor: ${Math.round((c/t)*100)}%`)
      });
      setRefArtifact(ref);

      // Process User (Practice)
      setStatus("Mapping Your Form...");
      // @ts-ignore - Assuming global or imported utility
      const user = await generateBodyPixOverlayFrames({
        videoUrl: userVideoUrl,
        fps: 12,
        opacity: 0.68,
        onProgress: (c: number, t: number) => setStatus(`Mapping User: ${Math.round((c/t)*100)}%`)
      });
      setUserArtifact(user);

      setStatus("Sync Active");
    } catch (err) {
      console.error("BodyPix Error:", err);
      setStatus("AI Analysis Failed");
    } finally {
      setIsProcessing(false);
    }
  }, [referenceVideoUrl, userVideoUrl, isProcessing, refArtifact, userArtifact]);

  // Trigger generation on mount
  useEffect(() => {
    runGeneration();
  }, [runGeneration]);

  // 2. Video Time Sync
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => setCurrentTime(video.currentTime);
    video.addEventListener('timeupdate', handleTimeUpdate);
    return () => video.removeEventListener('timeupdate', handleTimeUpdate);
  }, []);

  // 3. Frame Selection Logic
  const getFrame = (artifact: OverlayArtifact | null) => {
    if (!artifact || !artifact.frames || artifact.frames.length === 0) return null;
    const index = Math.floor(currentTime * artifact.fps);
    const clampedIndex = Math.max(0, Math.min(index, artifact.frames.length - 1));
    const frame = artifact.frames[clampedIndex];

    // Check if the frame is a Blob and convert it to a URL string
    if (frame instanceof Blob) {
      return URL.createObjectURL(frame);
    }
    
    return frame; // It's already a string (URL)
  };

  const instructorFrame = getFrame(refArtifact);
  const practiceFrame = getFrame(userArtifact);

  return (
    <div className="flex flex-col items-center gap-4 w-full max-w-5xl mx-auto p-4">
      
      {/* HEADER / STATUS */}
      <div className="w-full flex justify-between items-center bg-slate-900/50 p-3 rounded-t-xl border-x border-t border-white/10">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full animate-pulse ${isProcessing ? 'bg-amber-400' : 'bg-emerald-400'}`} />
          <span className="text-[10px] font-bold text-white uppercase tracking-widest">{status}</span>
        </div>
        <div className="flex gap-2">
           {/* Debug Indicators */}
           <div className={`w-3 h-3 rounded-full border border-white/20 ${instructorFrame ? 'bg-cyan-400 shadow-[0_0_8px_cyan]' : 'bg-red-900'}`} title="Ref Ghost Status" />
           <div className={`w-3 h-3 rounded-full border border-white/20 ${practiceFrame ? 'bg-emerald-400 shadow-[0_0_8px_emerald]' : 'bg-red-900'}`} title="User Overlay Status" />
        </div>
      </div>

      <div className="relative w-full aspect-video rounded-b-xl overflow-hidden bg-black shadow-2xl isolate">
      
        {/* LAYER 1: Raw Video - Lower Z and remove default display quirks */}
        <video
          ref={videoRef}
          src={userVideoUrl}
          className="absolute inset-0 w-full h-full z-0 object-contain"
          controls
          playsInline
        />

        {/* LAYER 2: Instructor Ghost - High Z and Forced Scale */}
        {instructorFrame && (
          <img
            src={instructorFrame}
            alt="Instructor Ghost"
            className="absolute inset-0 w-full h-full object-contain pointer-events-none z-50"
            style={{ 
              mixBlendMode: 'difference',
              filter: 'brightness(1.5) saturate(2)',
              opacity: 0.8
            }}
          />
        )}

        {/* LAYER 3: Practice Feedback - Highest Z */}
        {practiceFrame && (
          <img
            src={practiceFrame}
            alt="User Feedback"
            className="absolute inset-0 w-full h-full object-contain pointer-events-none z-[60]"
            style={{ 
              mixBlendMode: 'multiply',
              opacity: 0.6
            }}
          />
        )}
      </div>

      {/* FOOTER METADATA */}
      <div className="w-full flex justify-between px-1 text-[9px] font-mono text-slate-500 uppercase tracking-tighter">
        <span>Engine: EBS_DIFF_V2</span>
        <span>Resolution: {refArtifact?.width || 0}x{refArtifact?.height || 0}</span>
        <span>Latency: Synchronized</span>
      </div>
    </div>
  );
}