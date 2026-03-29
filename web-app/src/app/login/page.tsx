"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import Image from "next/image";

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white flex flex-col items-center justify-center px-6">
      <Link href="/" className="absolute top-8 left-8 flex items-center space-x-2 text-sm font-medium text-slate-500 hover:text-slate-900">
        <Image src="/logo.png" alt="TempoFlow" width={24} height={24} className="rounded" />
        <span>← Back</span>
      </Link>

      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="flex justify-center">
          <Image 
            src="/logo.png" 
            alt="TempoFlow" 
            width={64} 
            height={64}
            className="rounded-xl shadow-lg shadow-blue-500/20"
          />
        </div>

        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-800">Welcome</h2>
        </div>

        <div className="space-y-3">
          <button
            onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
            className="w-full flex items-center justify-center gap-3 px-6 py-3.5 text-slate-700 bg-white border border-slate-200 rounded-full hover:bg-slate-50 transition-all active:scale-[0.98] shadow-sm"
          >
            <img src="https://authjs.dev/img/providers/google.svg" alt="Google" className="w-5 h-5" />
            <span className="font-medium">Continue with Google</span>
          </button>
        </div>
      </div>
    </div>
  );
}