import type { ReactNode } from 'react';
import { ActivityDrawer } from './ActivityDrawer';
import { CommandDock } from './CommandDock';
import { ContextDrawerHost } from './ContextDrawerHost';
import { NavBar } from './NavBar';
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
      <div className="grid h-dvh grid-rows-[auto_auto_minmax(0,1fr)_auto]">
        <SystemStrip networkLabel={networkLabel} />
        <NavBar />
        <main id="main" className="lj-safe-x min-h-0 min-w-0 overflow-y-auto py-3 lg:py-5">
          {children}
        </main>
        <CommandDock />
        <ActivityDrawer />
        <ContextDrawerHost />
      </div>
    </WorkspaceProvider>
  );
}
