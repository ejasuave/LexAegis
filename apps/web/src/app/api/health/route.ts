import { jsonResponse, handleRoute } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Process liveness only. Healthy even while later integrations are unavailable. */
export const GET = handleRoute((requestId) =>
  jsonResponse({ status: 'ok', requestId }, 200, requestId),
);
