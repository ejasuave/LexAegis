import { jsonResponse, handleRoute } from '@/server/http';
import { getFeatureConfiguration } from '@/server/flags';
import { assistantVerified } from '@/server/assistant/runtime';
import type { CapabilityName } from '@/lib/readiness-schema';
import { buildReadinessReport } from '@/server/readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Capability readiness: 503 until every required capability has a verified implementation. */
export const GET = handleRoute(async (requestId) => {
  // "Verified" comes from stored capability evidence for the exact configuration, never from keys.
  const verified = new Set<CapabilityName>();
  if (await assistantVerified()) verified.add('assistant.qwen');
  const report = buildReadinessReport(
    { env: process.env, flags: getFeatureConfiguration().flags, verified },
    requestId,
  );
  return jsonResponse(report, report.status === 'ready' ? 200 : 503, requestId);
});
