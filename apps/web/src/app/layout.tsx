import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AccountProvider } from '@/components/account/account-context';
import { AssistantProvider } from '@/components/assistant/assistant-context';
import { HistoryProvider } from '@/components/history/history-context';
import { DecisionProvider } from '@/components/review/decision-context';
import { ReviewProvider } from '@/components/review/review-context';
import { AppShell } from '@/components/shell/AppShell';
import { FeatureFlagsProvider } from '@/components/shell/feature-flags-context';
import { loadPublicConfig, readPublicEnv } from '@/config/public';
import { getFeatureConfiguration } from '@/server/flags';
import './globals.css';

export const metadata: Metadata = {
  title: 'LexAegis',
  description: 'Proof of Review: human-approved AI work with independently checkable receipts.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

// Rendered per request so the network label reflects the running configuration. Feature flags are
// server-side values read once at process start; they are never NEXT_PUBLIC build-time constants.
export const dynamic = 'force-dynamic';

function networkLabel(result: ReturnType<typeof loadPublicConfig>): string {
  if (!result.ok) return 'Configuration invalid';
  if (result.config.chainId === '10143') return 'Monad Testnet (10143)';
  return result.config.chainId ? `Chain ${result.config.chainId}` : 'Not configured';
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const publicConfig = loadPublicConfig(readPublicEnv());
  // Public values only; an invalid configuration reaches the account feature as "not configured".
  const accountConfig = publicConfig.ok ? publicConfig.config : {};
  return (
    <html lang="en">
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-lj-soft focus:p-3"
        >
          Skip to main content
        </a>
        <FeatureFlagsProvider flags={getFeatureConfiguration().flags}>
          <AccountProvider config={accountConfig}>
            <ReviewProvider>
              <HistoryProvider>
                <DecisionProvider>
                  <AssistantProvider>
                    <AppShell networkLabel={networkLabel(publicConfig)}>{children}</AppShell>
                  </AssistantProvider>
                </DecisionProvider>
              </HistoryProvider>
            </ReviewProvider>
          </AccountProvider>
        </FeatureFlagsProvider>
      </body>
    </html>
  );
}
