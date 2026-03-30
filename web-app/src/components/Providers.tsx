'use client';

import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { SessionProvider } from "next-auth/react";
import { BackgroundSessionPostProcessor } from "./BackgroundSessionPostProcessor";

export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const enableBackgroundPostProcessing = pathname === "/analysis";

  return (
    <SessionProvider>
      {enableBackgroundPostProcessing ? (
        <Suspense fallback={null}>
          <BackgroundSessionPostProcessor />
        </Suspense>
      ) : null}
      {children}
    </SessionProvider>
  );
}
