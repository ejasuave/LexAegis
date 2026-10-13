'use client';

import { useCallback, useMemo } from 'react';
import { useAssistant } from '@/components/assistant/assistant-context';
import { useFeatureFlag } from '@/components/shell/feature-flags-context';
import { useStop } from '@/components/shell/stop-context';
import { useWorkspace } from '@/components/shell/workspace-context';
import {
  availableCommands,
  resolveInput,
  type CommandEntry,
  type Resolution,
} from '@/features/hud/public';

/**
 * The one dispatch path for the dock and the palette. It resolves input with the shared registry
 * and then either cancels directly, hands text to the editable dock, or gives an explicit command
 * to the assistant controller, whose own consent and validation path runs unchanged. Nothing here
 * can approve, sign, freeze or send: those stay with the reviewer's own controls.
 */
export function useCommandDispatch(): {
  readonly entries: readonly CommandEntry[];
  readonly resolve: (text: string) => Resolution;
  /** Requests cancellation directly: no model, no approval dialog. */
  readonly stop: () => void;
  /** Runs a resolved input. Resolves true when the request was taken up. */
  readonly run: (text: string) => Promise<boolean>;
  readonly focusDock: () => void;
} {
  const { controller } = useAssistant();
  const stopper = useStop();
  const { setDraft, dockInput, setCommandNote } = useWorkspace();
  const briefing = useFeatureFlag('matterBriefing');
  const entries = useMemo(() => availableCommands({ matterBriefing: briefing }), [briefing]);
  const resolve = useCallback((text: string) => resolveInput(entries, text), [entries]);

  const stop = useCallback(() => {
    const report = stopper.stop();
    setCommandNote(report.notes.join(' '));
  }, [stopper, setCommandNote]);

  const focusDock = useCallback(() => {
    // After the palette closes, so focus lands on the input and not on the opener.
    window.setTimeout(() => dockInput.current?.focus(), 0);
  }, [dockInput]);

  const run = useCallback(
    async (text: string): Promise<boolean> => {
      const resolution = resolveInput(entries, text);
      setCommandNote('');
      switch (resolution.kind) {
        case 'empty':
          return false;
        case 'stop':
          stop();
          return true;
        case 'text':
          // Free text needs review in the editable dock before anything is prepared.
          setDraft(resolution.text);
          focusDock();
          return true;
        case 'unknown':
          setCommandNote(
            resolution.suggestion === null
              ? `Unknown command ${resolution.typed}. Use the Commands list.`
              : `Unknown command ${resolution.typed}. Did you mean ${resolution.suggestion.command}?`,
          );
          return false;
        case 'refused':
        case 'command':
          if (controller === null) {
            setCommandNote('The assistant is not available in this browser session yet.');
            return false;
          }
          // The controller refuses approval wording itself and shows its own notice.
          await controller.submit(
            resolution.kind === 'command' ? resolution.text : resolution.text,
          );
          return true;
      }
    },
    [controller, entries, focusDock, setCommandNote, setDraft, stop],
  );

  return { entries, resolve, stop, run, focusDock };
}
