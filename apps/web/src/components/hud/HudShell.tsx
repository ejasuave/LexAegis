'use client';

import type { ReactNode } from 'react';
import { ActivityDrawer } from '@/components/shell/ActivityDrawer';
import { CommandDock } from '@/components/shell/CommandDock';
import { ContextDrawerHost } from '@/components/shell/ContextDrawerHost';
import { useWorkspace } from '@/components/shell/workspace-context';
import { CommandPalette } from './CommandPalette';
import { HudProvider } from './hud-context';
import { SystemCeiling } from './SystemCeiling';

function Frame({ children }: { children: ReactNode }) {
  const { paletteOpen } = useWorkspace();
  return (
    <div className="lj-app" data-effects="system">
      <div className="lj-art" aria-hidden="true" data-testid="art-layer" />
      {/* Contents only: the regions stay grid rows. A modal makes everything behind it inert. */}
      <div className="contents" inert={paletteOpen}>
        <SystemCeiling />
        <main id="main" className="lj-main lj-gutter">
          {children}
        </main>
        <CommandDock />
        <ActivityDrawer />
        <ContextDrawerHost />
      </div>
      <CommandPalette />
    </div>
  );
}

/**
 * Semantic regions on one stacking context: ceiling, working area and dock occupy real layout
 * rows, so nothing covers document content, focus outlines or scrollbars. The decorative art
 * layer sits behind everything and is removable without losing any capability.
 */
export function HudShell({
  networkLabel,
  chainId,
  children,
}: {
  networkLabel: string;
  chainId: string | null;
  children: ReactNode;
}) {
  return (
    <HudProvider networkLabel={networkLabel} chainId={chainId}>
      <Frame>{children}</Frame>
    </HudProvider>
  );
}
