'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useApproval } from '@/components/review/approval-context';
import { ActivityDrawer } from '@/components/shell/ActivityDrawer';
import { CommandDock } from '@/components/shell/CommandDock';
import { ContextDrawerHost } from '@/components/shell/ContextDrawerHost';
import { useWorkspace } from '@/components/shell/workspace-context';
import { resolveEffects, type SceneState } from '@/features/hud/public';
import { ApprovalCeremony } from './ApprovalCeremony';
import { CommandPalette } from './CommandPalette';
import { isCeremonyStage } from './ceremony';
import { useEffectsEnvironment } from './effects-preference';
import { HudProvider, useHud } from './hud-context';
import { NeuralCanvas } from './NeuralCanvas';
import { SystemCeiling } from './SystemCeiling';
import { useHudAnchors } from './useHudAnchors';

/** The approval ceremony is the one moment the art goes still and dim. */

function Frame({ children }: { children: ReactNode }) {
  const { paletteOpen } = useWorkspace();
  const { view, setVisibleFindingIds, receipt, loading } = useHud();
  const approval = useApproval().snapshot.stage;
  const pathname = usePathname();
  const environment = useEffectsEnvironment();
  const [canvasFailed, setCanvasFailed] = useState(false);
  const onFail = useCallback(() => setCanvasFailed(true), []);
  const mode = resolveEffects({ ...environment, canvasFailed });
  const anchors = useHudAnchors(view, setVisibleFindingIds, [pathname]);
  const activity = view.activity;
  const busyRegion = loading.view.visible ? (loading.view.work?.region ?? null) : null;
  const pending = useMemo(() => {
    if (busyRegion === null) return null;
    const target = anchors.busy.find((entry) => entry.regions.includes(busyRegion));
    return target === undefined ? { x: null, y: null } : { x: target.x, y: target.y };
  }, [busyRegion, anchors.busy]);
  const ceremony = isCeremonyStage(approval);
  const scene = useMemo<SceneState>(
    () => ({
      activity: activity.state,
      toolsRunning: activity.toolsRunning,
      ceremony,
      nucleus: anchors.nucleus,
      regions: anchors.regions,
      channelX: anchors.channelX,
      alerts: anchors.alerts,
      workspace: view.workspaceEmpty ? 'empty' : 'matter',
      stage: anchors.stage,
      wash: receipt.wash,
      pending,
    }),
    [
      activity.state,
      activity.toolsRunning,
      ceremony,
      anchors,
      receipt.wash,
      view.workspaceEmpty,
      pending,
    ],
  );
  return (
    <div
      className="lj-app"
      data-effects={mode}
      data-canvas={mode === 'off' ? 'off' : 'on'}
      data-busy={busyRegion ?? undefined}
    >
      <div className="lj-art" aria-hidden="true" data-testid="art-layer">
        <NeuralCanvas mode={mode} scene={scene} onFail={onFail} />
      </div>
      {/* Contents only: the regions stay grid rows. A modal makes everything behind it inert. */}
      <div className="contents" inert={paletteOpen || ceremony}>
        <SystemCeiling />
        <main
          id="main"
          className="lj-main lj-gutter"
          data-hud-quiet={pathname === '/review' || pathname === '/hud-fixtures' ? undefined : ''}
        >
          {children}
        </main>
        <CommandDock />
        <ActivityDrawer />
        <ContextDrawerHost />
      </div>
      <ApprovalCeremony />
      <CommandPalette />
      {/* One polite announcement per accepted event; it never depends on the effect playing. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="receipt-announcement">
        {receipt.announcement?.text ?? ''}
      </p>
      {/* Start and finish of real pending work, said once each; never progress ticks. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="loading-announcement">
        {loading.announcement?.text ?? ''}
      </p>
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
