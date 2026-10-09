import type { ReactNode } from 'react';
import { ActivityDrawer } from './ActivityDrawer';
import { CommandDock } from './CommandDock';
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
      <div className="grid min-h-dvh grid-rows-[auto_auto_minmax(0,1fr)_auto]">
        <SystemStrip networkLabel={networkLabel} />
        <NavBar />
        <main id="main" className="min-h-0 min-w-0 overflow-y-auto p-3 lg:p-5">
          {children}
        </main>
        <CommandDock />
        <ActivityDrawer />
      </div>
    </WorkspaceProvider>
  );
}
