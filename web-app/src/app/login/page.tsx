"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6">
      <Link href="/" className="absolute top-8 left-8 text-sm font-medium text-gray-500 hover:text-gray-900">
        ← Back to Home
      </Link>

      <div className="w-full max-w-md space-y-8 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500 shadow-lg shadow-purple-100">
          <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>

        <div>
          <h2 className="text-3xl font-bold tracking-tight text-gray-900">Welcome back</h2>
          <p className="mt-2 text-gray-600">Sign in to sync your dance sessions to the cloud.</p>
        </div>

        <div className="space-y-4">
          <button
            onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
            className="w-full flex items-center justify-center gap-3 px-6 py-4 text-gray-700 bg-white border border-gray-200 rounded-full hover:bg-gray-50 transition-all active:scale-[0.98] shadow-sm"
          >
            <img src="https://authjs.dev/img/providers/google.svg" alt="Google" className="w-5 h-5" />
            <span className="font-medium">Continue with Google</span>
          </button>
          
          <p className="text-xs text-gray-400 px-8">
            By signing in, you agree to store your pose analysis data in our secure DynamoDB cloud.
          </p>
        </div>
      </div>
    </div>
  );
}