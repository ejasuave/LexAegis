'use client';

import type { ReactNode } from 'react';
import { ActivityDrawer } from '@/components/shell/ActivityDrawer';
import { CommandDock } from '@/components/shell/CommandDock';
import { ContextDrawerHost } from '@/components/shell/ContextDrawerHost';
import { SystemCeiling } from './SystemCeiling';

/**
 * Semantic regions on one stacking context: ceiling, working area and dock occupy real layout
 * rows, so nothing covers document content, focus outlines or scrollbars. The decorative art
 * layer sits behind everything and is removable without losing any capability.
 */
export function HudShell({
  networkLabel,
  children,
}: {
  networkLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="lj-app" data-effects="system">
      <div className="lj-art" aria-hidden="true" data-testid="art-layer" />
      <SystemCeiling networkLabel={networkLabel} />
      <main id="main" className="lj-main lj-gutter">
        {children}
      </main>
      <CommandDock />
      <ActivityDrawer />
      <ContextDrawerHost />
    </div>
  );
}
