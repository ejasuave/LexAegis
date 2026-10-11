import { useState } from 'react';

/** Copies one public value. A failure is stated, never hidden. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <>
      <button
        type="button"
        className="btn"
        aria-label={`Copy ${label}`}
        onClick={() => {
          navigator.clipboard.writeText(value).then(
            () => setState('copied'),
            () => setState('failed'),
          );
        }}
      >
        Copy
      </button>
      <span role="status" className="text-[0.8125rem] text-lj-secondary">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy was not allowed here' : ''}
      </span>
    </>
  );
}
