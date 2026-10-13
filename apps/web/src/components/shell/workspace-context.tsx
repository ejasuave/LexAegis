'use client';

import {
  createContext,
  useRef,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type RefObject,
  type ReactNode,
  type SetStateAction,
} from 'react';

export type PresentationMode = 'command' | 'review';
export type MobileTab = 'matter' | 'document' | 'findings' | 'activity';

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
  setDraft: Dispatch<SetStateAction<string>>;
  activityOpen: boolean;
  setActivityOpen: (open: boolean) => void;
  contextOpen: boolean;
  setContextOpen: (open: boolean) => void;
  /** The command palette. It shares the draft and the registry with the dock. */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** The dock's editable input, so the palette can hand free text to it. */
  dockInput: RefObject<HTMLTextAreaElement | null>;
  /** Short factual result of the last command (for example what Stop did). Volatile. */
  commandNote: string;
  setCommandNote: (note: string) => void;
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [commandNote, setCommandNote] = useState('');
  const dockInput = useRef<HTMLTextAreaElement | null>(null);

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
      paletteOpen,
      setPaletteOpen,
      dockInput,
      commandNote,
      setCommandNote,
      selection: EMPTY_SELECTION,
    }),
    [mode, mobileTab, draft, activityOpen, contextOpen, paletteOpen, commandNote],
  );
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return value;
}
