'use client';

import { useEffect, useState } from 'react';
import { readinessReportSchema, type ReadinessReport } from '@/lib/readiness-schema';
import { Icon } from './icons';

type Load =
  { status: 'loading' } | { status: 'failed' } | { status: 'loaded'; report: ReadinessReport };

const STATE_LABEL: Record<string, string> = {
  unimplemented: 'Not built yet',
  unconfigured: 'Not configured',
  configured: 'Configured, not verified',
  verified: 'Verified',
  blocked: 'Blocked by invalid configuration',
};

/** Shows the real /api/readiness response, including its 503: unavailable is a valid answer. */
export function ReadinessPanel() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/readiness', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const parsed = readinessReportSchema.safeParse(await response.json());
        setLoad(parsed.success ? { status: 'loaded', report: parsed.data } : { status: 'failed' });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad({ status: 'failed' });
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <section aria-labelledby="readiness-title" className="mt-6">
      <h2 id="readiness-title" className="m-0 text-lg font-medium">
        Integration readiness
      </h2>
      {load.status === 'loading' ? (
        <p role="status" className="mt-2 text-[0.875rem] text-lj-secondary">
          <Icon name="loading" className="mr-2 inline" />
          Checking readiness…
        </p>
      ) : null}
      {load.status === 'failed' ? (
        <div className="mt-2">
          <p role="alert" className="m-0 text-[0.875rem] text-lj-error">
            <Icon name="alert" className="mr-2 inline" />
            Readiness could not be read. This does not mean the integrations are ready.
          </p>
          <button
            type="button"
            className="mt-2 min-h-11 rounded border border-lj-edge px-3 text-[0.875rem]"
            onClick={() => {
              setLoad({ status: 'loading' });
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : null}
      {load.status === 'loaded' ? (
        <>
          <p className="mt-2 text-[0.875rem] text-lj-secondary">
            {load.report.status === 'ready'
              ? 'All required capabilities are verified.'
              : 'Not ready: required capabilities are unavailable.'}
          </p>
          <ul className="mt-2 list-none p-0 text-[0.875rem]">
            {load.report.capabilities.map((capability) => (
              <li
                key={capability.name}
                className="flex justify-between gap-3 border-b border-lj-divider py-1"
              >
                <span className="font-mono">{capability.name}</span>
                <span className="text-lj-secondary">
                  {STATE_LABEL[capability.state] ?? capability.state}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
