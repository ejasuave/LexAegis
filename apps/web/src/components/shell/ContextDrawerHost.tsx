'use client';

import { ContextDrawer } from './ContextDrawer';
import { useWorkspace } from './workspace-context';

export function ContextDrawerHost() {
  const { contextOpen, setContextOpen } = useWorkspace();
  return <ContextDrawer open={contextOpen} onClose={() => setContextOpen(false)} />;
}
