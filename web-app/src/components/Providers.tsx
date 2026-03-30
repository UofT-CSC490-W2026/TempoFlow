'use client';

import { Suspense } from "react";
import { SessionProvider } from "next-auth/react";
import { BackgroundSessionPostProcessor } from "./BackgroundSessionPostProcessor";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <Suspense fallback={null}>
        <BackgroundSessionPostProcessor />
      </Suspense>
      {children}
    </SessionProvider>
  );
}
