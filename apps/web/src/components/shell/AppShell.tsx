import type { ReactNode } from 'react';
import { ActivityDrawer } from './ActivityDrawer';
import { CommandDock } from './CommandDock';
import { ContextDrawerHost } from './ContextDrawerHost';
import { NavBar } from './NavBar';
import { VoiceProvider } from '@/components/voice/voice-context';
import { StopProvider } from './stop-context';
import { SystemStrip } from './SystemStrip';
import { WorkspaceProvider } from './workspace-context';

/** Ceiling, navigation, working area and dock occupy real layout rows; nothing covers content. */
export function AppShell({
  networkLabel,
  children,
}: {
  networkLabel: string;
  children: ReactNode;
}) {
  return (
    <WorkspaceProvider>
      <StopProvider>
        <VoiceProvider>
          <div className="grid min-h-dvh grid-rows-[auto_auto_minmax(0,1fr)_auto] lg:h-dvh">
            <SystemStrip networkLabel={networkLabel} />
            <NavBar />
            <main id="main" className="lj-safe-x min-h-0 min-w-0 py-3 lg:overflow-y-auto lg:py-5">
              {children}
            </main>
            <CommandDock />
            <ActivityDrawer />
            <ContextDrawerHost />
          </div>
        </VoiceProvider>
      </StopProvider>
    </WorkspaceProvider>
  );
}
