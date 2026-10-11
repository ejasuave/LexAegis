import type { Metadata } from 'next';
import { EmptyState } from '@/components/shell/EmptyState';
import { loadPublicConfig, readPublicEnv } from '@/config/public';

export const metadata: Metadata = { title: 'Verify · LexAegis' };
export const dynamic = 'force-dynamic';

export default function VerifyPage() {
  const result = loadPublicConfig(readPublicEnv());
  const origin = result.ok ? result.config.verifierOrigin : undefined;
  return (
    <EmptyState
      title="Verify"
      description="Receipts are checked in the separate verifier, which needs no LexAegis account, passkey or backend. This app opens it with nothing attached: you download the readable export and choose it there yourself, then paste the public receipt reference you expect."
    >
      {origin ? (
        <p className="mt-4">
          <a
            href={origin}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center rounded border border-lj-edge px-4 text-[0.875rem] underline"
          >
            Open the independent verifier (new tab)
          </a>
        </p>
      ) : (
        <p className="mt-4 text-[0.875rem] text-lj-secondary">
          The verifier address is not configured.
        </p>
      )}
    </EmptyState>
  );
}
