import type { SVGProps } from 'react';

const PATHS = {
  unavailable: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-6.4 3.6 12.8 10.8',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  network: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  key: 'M14 10a4 4 0 1 0-3.9 4H12l1 1h2v2h2v-2h1v-2h-3.1',
  file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  stop: 'M6 6h12v12H6z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-6 9a6 6 0 0 0 12 0M12 18v3',
  send: 'M4 12 20 4l-6 16-3-7z',
  index: 'M4 6h16M4 12h16M4 18h10',
  tx: 'M5 8h12l-3-3m3 3-3 3M19 16H7l3 3m-3-3 3-3',
  check: 'm5 12 4 4 10-10',
  alert: 'M12 4 3 20h18zM12 10v4m0 3v.01',
  loading: 'M12 4a8 8 0 1 0 8 8',
} as const;

export type IconName = keyof typeof PATHS;

/** Decorative outlined icon. Meaning is always carried by adjacent text. */
export function Icon({ name, ...rest }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
