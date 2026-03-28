import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-white" suppressHydrationWarning>
      {/* --- Login / Navigation Header --- */}
      <header className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-8 py-6">
        <div className="flex items-center space-x-2">
          {/* Small mini-logo for the top left */}
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            </svg>
          </div>
          <span className="font-bold text-gray-900 tracking-tight">TempoFlow</span>
        </div>

        <div className="flex items-center space-x-4">
          <Link 
            href="/login" 
            className="px-5 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-full hover:bg-gray-50 transition-all active:scale-95 shadow-sm"
          >
            Log In
          </Link>
          <Link 
            href="/signup" 
            className="px-5 py-2 text-sm font-medium text-white bg-gray-900 rounded-full hover:bg-gray-800 transition-all active:scale-95 shadow-sm"
          >
            Sign Up
          </Link>
        </div>
      </header>

      {/* --- Hero Section --- */}
      <div className="flex flex-col items-center justify-center min-h-screen px-6 py-12 pt-24">
        <div className="max-w-2xl mx-auto text-center space-y-8">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-gradient-to-br from-purple-500 to-pink-500 mb-4 shadow-xl">
            <svg className="w-12 h-12 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>

          <h1 className="text-5xl md:text-7xl font-bold tracking-tight text-gray-900">
            TempoFlow
          </h1>
          
          <p className="text-xl md:text-2xl text-gray-600 font-light">
            Your AI dance coach that catches what the eye misses
          </p>

          <div className="rounded-3xl border border-gray-200 bg-gray-50 px-6 py-5 text-left shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">Local-first mode</p>
            <p className="mt-2 text-gray-700">
              Upload a reference clip and your practice clip, keep them on this device for now, and get timing-first feedback with pose-based comparison.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link 
              href="/upload"
              className="inline-flex items-center justify-center px-8 py-4 text-lg font-medium text-white bg-gray-900 rounded-full hover:bg-gray-800 transition-all active:scale-95 shadow-lg"
            >
              Start Session
            </Link>
            <Link
              href="/dashboard"
              className="inline-flex items-center justify-center px-8 py-4 text-lg font-medium text-gray-800 bg-gray-100 rounded-full hover:bg-gray-200 transition-all active:scale-95"
            >
              Open Dashboard
            </Link>
          </div>

          <div className="flex flex-wrap justify-center gap-3 pt-8">
            <div className="px-4 py-2 bg-gray-100 rounded-full text-sm text-gray-700">
              Local session storage
            </div>
            <div className="px-4 py-2 bg-gray-100 rounded-full text-sm text-gray-700">
              Pose-based comparison
            </div>
            <div className="px-4 py-2 bg-gray-100 rounded-full text-sm text-gray-700">
              API-ready coaching
            </div>
          </div>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 p-6 text-center text-sm text-gray-400">
        Made for dancers, by dancers
      </div>
    </div>
  );
}