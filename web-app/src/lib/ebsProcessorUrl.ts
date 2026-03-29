/**
 * Public URL for the EBS / alignment processor (`/api/process` on the A5 FastAPI app).
 *
 * - Set `NEXT_PUBLIC_EBS_PROCESSOR_URL` for an explicit URL (e.g. local dev).
 * - On HTTPS hosting (Amplify), the browser cannot call an HTTP ALB (mixed content).
 *   Set `NEXT_PUBLIC_EBS_PROXY=1` and configure `EBS_BACKEND_URL` at **build** time so
 *   Next.js rewrites `/api/ebs-backend/*` to the ALB (see `next.config.ts`).
 */
export function getPublicEbsProcessorUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_EBS_PROCESSOR_URL;
  if (explicit) return explicit;
  if (process.env.NEXT_PUBLIC_EBS_PROXY === '1') {
    return '/api/ebs-backend/api/process';
  }
  return 'http://127.0.0.1:8787/api/process';
}
