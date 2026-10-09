import { jsonResponse, handleRoute } from '@/server/http';
import { getFeatureConfiguration } from '@/server/flags';
import { buildReadinessReport } from '@/server/readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Capability readiness: 503 until every required capability has a verified implementation. */
export const GET = handleRoute((requestId) => {
  const report = buildReadinessReport(
    { env: process.env, flags: getFeatureConfiguration().flags },
    requestId,
  );
  return jsonResponse(report, report.status === 'ready' ? 200 : 503, requestId);
});
