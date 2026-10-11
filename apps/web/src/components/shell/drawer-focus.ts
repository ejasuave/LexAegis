import { useEffect, useRef, type RefObject } from 'react';

/**
 * Focus handling for a non-modal drawer: focus moves into it when it opens, Escape closes it
 * (and never confirms anything), and focus returns to whatever opened it. The page behind stays
 * usable, so focus is not trapped.
 */
export function useDrawerFocus(
  open: boolean,
  onClose: () => void,
  container: RefObject<HTMLElement | null>,
): void {
  const opener = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = container.current?.querySelector<HTMLElement>('button, [href], [tabindex]');
    target?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && container.current?.contains(document.activeElement)) {
        event.preventDefault();
        close.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const back = opener.current;
      opener.current = null;
      if (back !== null && document.contains(back)) back.focus();
    };
  }, [open, container]);
}
