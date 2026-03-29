'use client'

import { useState, useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import Image from "next/image";

export default function Home() {
  const { data: session, status } = useSession();
  const [mounted, setMounted] = useState(false);

  // Fixes Hydration Mismatch: 
  // Ensures server and client render 'null' first, 
  // then client renders the actual UI.
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null; 
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white" suppressHydrationWarning>
      {/* --- Navigation Header --- */}
      <header className="absolute top-0 left-0 right-0 z-10 flex items-center justify-end px-8 py-6">
        <div className="flex items-center space-x-3">
          <Link 
            href="/login" 
            className="px-5 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
          >
            Log In
          </Link>
          <Link 
            href="/upload" 
            className="px-5 py-2 text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full hover:from-blue-600 hover:to-cyan-500 transition-all active:scale-95 shadow-md"
          >
            Start
          </Link>
        </div>
      </header>

      {/* --- Hero Section --- */}
      <div className="flex flex-col items-center justify-center min-h-screen px-6">
        <div className="max-w-xl mx-auto text-center space-y-8">
          {/* Centered Logo */}
          <div className="flex justify-center">
            <Image 
              src="/logo.png" 
              alt="TempoFlow" 
              width={300} 
              height={85}
              className="drop-shadow-lg"
              priority
            />
          </div>
          
          <p className="text-lg text-slate-500 font-light">
            AI dance coach
          </p>

          <div className="pt-8">
            <Link 
              href="/upload"
              className="inline-flex items-center justify-center px-10 py-4 text-lg font-medium text-white bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full hover:from-blue-600 hover:to-cyan-500 transition-all active:scale-95 shadow-lg shadow-blue-500/25"
            >
              Start Session
            </Link>
          </div>

          <div className="flex flex-wrap justify-center gap-2 pt-6">
            <span className="px-3 py-1 bg-white border border-slate-200 rounded-full text-xs text-slate-500">
              Local processing
            </span>
            <span className="px-3 py-1 bg-white border border-slate-200 rounded-full text-xs text-slate-500">
              Pose analysis
            </span>
            <span className="px-3 py-1 bg-white border border-slate-200 rounded-full text-xs text-slate-500">
              AI feedback
            </span>
          </div>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 p-4 text-center text-xs text-slate-300">
        TempoFlow
      </div>
    </div>
  );
}