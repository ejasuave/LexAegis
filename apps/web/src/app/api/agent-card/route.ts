import { agentCardOutcome } from '@/server/agent-card';
import { getFeatureConfiguration } from '@/server/flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The public ERC-8004 registration file. No session, cookie or user data: the same bytes for every
 * caller. Not published (404) while the feature is off or the app has no public https origin.
 */
export function GET(): Response {
  const outcome = agentCardOutcome(process.env, getFeatureConfiguration().flags.agentIdentity);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=300',
  };
  return outcome.status === 200
    ? new Response(JSON.stringify(outcome.card), { status: 200, headers })
    : new Response(JSON.stringify({ status: 'not_published', reason: outcome.reason }), {
        status: 404,
        headers: { ...headers, 'cache-control': 'no-store' },
      });
}
