'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useAccount } from '@/components/account/account-context';
import { useReview } from '@/components/review/review-context';
import { useFeatureFlag } from '@/components/shell/feature-flags-context';
import { useStop } from '@/components/shell/stop-context';
import { useWorkspace } from '@/components/shell/workspace-context';
import { useVault } from '@/components/vault/vault-context';
import {
  ReadAloudController,
  VoiceController,
  browserRecognitionAdapter,
  browserSynthesisAdapter,
  type ReadAloudSnapshot,
  type VoiceSnapshot,
} from '@/features/voice/public';

interface VoiceContextValue {
  readonly voice: VoiceController | null;
  readonly reader: ReadAloudController | null;
  readonly voiceState: VoiceSnapshot | null;
  readonly readState: ReadAloudSnapshot | null;
}

const VoiceContext = createContext<VoiceContextValue>({
  voice: null,
  reader: null,
  voiceState: null,
  readState: null,
});

const noSubscription = () => () => undefined;
const nothing = () => null;

/**
 * Owns on-device dictation and read-aloud, only while the voice flag is on. Both are subordinate
 * to the existing workspace: Listening and Speaking describe real device activity, not model
 * readiness, approval or a chain result. Everything is cancelled on lock, a hidden page, an
 * account, matter or version change and on unmount.
 */
export function VoiceProvider({ children }: { children: ReactNode }) {
  const enabled = useFeatureFlag('voice');
  const { setDraft } = useWorkspace();
  const stop = useStop();
  const vault = useVault();
  const account = useAccount();
  const review = useReview().snapshot;
  const [voice, setVoice] = useState<VoiceController | null>(null);
  const [reader, setReader] = useState<ReadAloudController | null>(null);
  const voiceRef = useRef<VoiceController | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const storage = (() => {
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    })();
    const nextReader = new ReadAloudController({
      adapter: browserSynthesisAdapter(window),
      isListening: () => voiceRef.current?.isActive() === true,
      storage,
    });
    const nextVoice = new VoiceController({
      adapter: browserRecognitionAdapter(window),
      // Appended to the latest draft, so text typed meanwhile is never overwritten.
      onFinalText: (text) =>
        setDraft((previous) => (previous === '' ? text : `${previous.trimEnd()} ${text}`)),
      stopPlayback: () => nextReader.cancel('dictation_started'),
    });
    voiceRef.current = nextVoice;
    stop.register('voice', { active: () => nextVoice.isActive(), abort: () => nextVoice.abort() });
    stop.register('readAloud', {
      active: () => nextReader.isActive(),
      cancel: () => nextReader.cancel('stop'),
    });
    void nextVoice.refreshCapability();
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        nextVoice.abort();
        nextReader.cancel('hidden');
      }
    };
    document.addEventListener('visibilitychange', onHidden);
    setVoice(nextVoice);
    setReader(nextReader);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      stop.register('voice', null);
      stop.register('readAloud', null);
      nextVoice.dispose();
      nextReader.dispose();
      voiceRef.current = null;
      setVoice(null);
      setReader(null);
    };
    // The controllers are built once per enablement; their callbacks read live state.
  }, [enabled, setDraft, stop]);

  const versions = review.documents
    .filter((doc) => doc.selected)
    .map((doc) => doc.documentVersionId)
    .join(',');
  const scope = `${account.snapshot.account?.address ?? ''}|${account.snapshot.generation}|${vault.snapshot.generation}|${vault.snapshot.state}|${vault.snapshot.selectedMatterId ?? ''}|${versions}`;
  useEffect(() => {
    // Lock, account, matter or version change: nothing spoken or heard carries over.
    voice?.abort();
    reader?.cancel('context_changed');
  }, [scope, voice, reader]);

  const voiceState = useSyncExternalStore(
    voice?.subscribe ?? noSubscription,
    voice?.getSnapshot ?? nothing,
    nothing,
  );
  const readState = useSyncExternalStore(
    reader?.subscribe ?? noSubscription,
    reader?.getSnapshot ?? nothing,
    nothing,
  );
  return (
    <VoiceContext.Provider value={{ voice, reader, voiceState, readState }}>
      {children}
    </VoiceContext.Provider>
  );
}

export function useVoice(): VoiceContextValue {
  return useContext(VoiceContext);
}
