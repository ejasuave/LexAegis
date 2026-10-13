import type { ReactNode } from 'react';
import { HudShell } from '@/components/hud/HudShell';
import { VoiceProvider } from '@/components/voice/voice-context';
import { StopProvider } from './stop-context';
import { WorkspaceProvider } from './workspace-context';

/** Providers for view state, Stop and voice around the HUD regions. */
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
          <HudShell networkLabel={networkLabel}>{children}</HudShell>
        </VoiceProvider>
      </StopProvider>
    </WorkspaceProvider>
  );
}
