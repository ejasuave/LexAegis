'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export type PresentationMode = 'command' | 'review';
export type MobileTab = 'document' | 'aegis' | 'findings' | 'package';

/** The selected matter/document/clause. Null until a later chapter provides real matters. */
export interface Selection {
  readonly matterId: string | null;
  readonly documentVersionId: string | null;
  readonly clauseId: string | null;
}

interface WorkspaceState {
  mode: PresentationMode;
  setMode: (mode: PresentationMode) => void;
  mobileTab: MobileTab;
  setMobileTab: (tab: MobileTab) => void;
  /** Unsent command draft; volatile and never persisted. */
  draft: string;
  setDraft: (draft: string) => void;
  activityOpen: boolean;
  setActivityOpen: (open: boolean) => void;
  contextOpen: boolean;
  setContextOpen: (open: boolean) => void;
  selection: Selection;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

const EMPTY_SELECTION: Selection = { matterId: null, documentVersionId: null, clauseId: null };

/**
 * Single owner of view state so switching Command-centre and Review modes (or navigating
 * between pages) keeps the selection and the unsent draft.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<PresentationMode>('command');
  const [mobileTab, setMobileTab] = useState<MobileTab>('document');
  const [draft, setDraft] = useState('');
  const [activityOpen, setActivityOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  const value = useMemo<WorkspaceState>(
    () => ({
      mode,
      setMode,
      mobileTab,
      setMobileTab,
      draft,
      setDraft,
      activityOpen,
      setActivityOpen,
      contextOpen,
      setContextOpen,
      selection: EMPTY_SELECTION,
    }),
    [mode, mobileTab, draft, activityOpen, contextOpen],
  );
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return value;
}
