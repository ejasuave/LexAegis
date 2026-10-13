'use client';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useAssistant } from '@/components/assistant/assistant-context';
import { useApproval } from '@/components/review/approval-context';
import { useStop } from '@/components/shell/stop-context';
import { useWorkspace } from '@/components/shell/workspace-context';
import { filterCommands, type CommandEntry } from '@/features/hud/public';
import { useCommandDispatch } from './use-command-dispatch';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Global command palette. A modal dialog with a combobox and listbox: opened by Ctrl or Cmd + K,
 * dismissed by Escape (which never approves, signs or cancels a task), focus contained while
 * open and restored on close. It shares the registry and draft with the dock.
 */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useWorkspace();
  const approval = useApproval();
  const approvalBusy = approval.snapshot.stage !== 'idle';
  const approvalBusyRef = useRef(approvalBusy);
  approvalBusyRef.current = approvalBusy;
  const openRef = useRef(paletteOpen);
  openRef.current = paletteOpen;

  // One scoped shortcut listener; removed on unmount. It never overrides other chords.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey)) return;
      if (event.altKey || event.shiftKey || event.isComposing || event.repeat) return;
      // The exact-action approval keeps its own focus boundary: no palette over it.
      if (approvalBusyRef.current) return;
      event.preventDefault();
      setPaletteOpen(!openRef.current);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setPaletteOpen]);

  useEffect(() => {
    if (paletteOpen && approvalBusy) setPaletteOpen(false);
  }, [paletteOpen, approvalBusy, setPaletteOpen]);

  return paletteOpen ? <PaletteDialog /> : null;
}

/** Mounted only while open, so its state starts fresh and no effect races the first keystroke. */
function PaletteDialog() {
  const { setPaletteOpen, draft } = useWorkspace();
  const { snapshot } = useAssistant();
  const stopper = useStop();
  const dispatch = useCommandDispatch();
  // Seeded from the shared draft when it is a command being typed. Read once, at open time.
  const [query, setQuery] = useState(() => (draft.startsWith('/') ? draft : ''));
  const [active, setActive] = useState(0);
  const dialog = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  // Captured before focus moves into the dialog, so Escape can put it back.
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const ids = useId();
  const listId = `${ids}-list`;
  const close = useCallback(() => setPaletteOpen(false), [setPaletteOpen]);

  useEffect(() => {
    input.current?.focus();
    return () => {
      if (opener !== null && document.contains(opener)) opener.focus();
      else document.querySelector<HTMLElement>('[data-testid="commands-launcher"]')?.focus();
    };
  }, [opener]);

  const results: readonly CommandEntry[] = filterCommands(dispatch.entries, query);
  const slashy = query.trim() === '' || query.trim().startsWith('/');
  const activeEntry = active >= 0 ? results[Math.min(active, results.length - 1)] : undefined;
  const stoppable =
    snapshot.phase === 'running' ||
    snapshot.phase === 'stopping' ||
    snapshot.phase === 'preview' ||
    stopper.canStop();

  const choose = async () => {
    const text = query.trim();
    if (activeEntry !== undefined && (slashy || active >= 0)) {
      // Keep arguments typed after a command name; otherwise the command alone.
      const typedName = text.split(/\s+/)[0]?.toLowerCase();
      const rest =
        typedName !== undefined && typedName === activeEntry.command
          ? text.slice(typedName.length).trim()
          : '';
      close();
      await dispatch.run(rest === '' ? activeEntry.command : `${activeEntry.command} ${rest}`);
      return;
    }
    if (text === '') return;
    close();
    await dispatch.run(text);
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.key === 'Process') return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current + step + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void choose();
    }
  };

  // Escape and Tab containment live on the dialog so they work from any focused control.
  const onDialogKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const optionId = (index: number) => `${ids}-opt-${String(index)}`;
  return (
    <div className="lj-palette-scrim" data-palette-open="true">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="lj-palette lj-drawer"
        onKeyDown={onDialogKey}
      >
        <div className="flex items-center gap-2">
          <label htmlFor={`${ids}-input`} className="sr-only">
            Search commands or type a request
          </label>
          <input
            ref={input}
            id={`${ids}-input`}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              activeEntry === undefined ? undefined : optionId(Math.max(active, 0))
            }
            autoComplete="off"
            spellCheck={false}
            maxLength={2000}
            value={query}
            placeholder="Type / for commands, or describe what you need"
            className="lj-dock-field min-h-11 min-w-0 flex-1 rounded border border-lj-edge bg-lj-soft px-3 font-mono text-base leading-6 text-lj-text placeholder:text-lj-muted"
            onChange={(event) => {
              setQuery(event.target.value);
              const slash =
                event.target.value.trim() === '' || event.target.value.trim().startsWith('/');
              setActive(slash ? 0 : -1);
            }}
            onKeyDown={onInputKey}
          />
          <button
            type="button"
            className="min-h-11 min-w-11 rounded border border-lj-edge px-3 text-[0.875rem]"
            onClick={close}
          >
            Close
          </button>
        </div>
        <ul
          id={listId}
          role="listbox"
          aria-label="Commands"
          className="m-0 mt-2 list-none overflow-y-auto p-0"
        >
          {results.map((entry, index) => (
            <li
              key={entry.command}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              className={`cursor-pointer border-l-2 px-3 py-2 ${
                index === active ? 'border-lj-cyan bg-lj-raised' : 'border-transparent'
              }`}
              onMouseMove={() => setActive(index)}
              onClick={() => {
                setActive(index);
                void (async () => {
                  close();
                  await dispatch.run(entry.command);
                })();
              }}
            >
              <span className="font-mono text-[0.9375rem] text-lj-text">{entry.command}</span>
              <span className="ml-3 text-[0.875rem] text-lj-secondary">{entry.title}</span>
              <span className="mt-0.5 block text-[0.8125rem] text-lj-muted">{entry.boundary}</span>
            </li>
          ))}
        </ul>
        <p role="status" aria-live="polite" className="m-0 mt-2 text-[0.8125rem] text-lj-secondary">
          {results.length === 0
            ? query.trim().startsWith('/')
              ? 'No matching command. Press Enter to see a suggestion.'
              : 'No command matches. Press Enter to move your text to the command box for review.'
            : `${String(results.length)} command${results.length === 1 ? '' : 's'}. Press Enter to ${
                active >= 0 ? 'run the highlighted command' : 'move your text to the command box'
              }. Escape closes this list and approves nothing.`}
        </p>
        {stoppable ? (
          <button
            type="button"
            className="mt-2 min-h-11 min-w-11 rounded border border-lj-edge px-4 text-[0.875rem]"
            data-testid="palette-stop"
            onClick={() => dispatch.stop()}
          >
            Stop
          </button>
        ) : null}
      </div>
    </div>
  );
}
