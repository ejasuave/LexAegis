export const btn =
  'min-h-11 rounded border border-lj-edge px-4 text-[0.875rem] disabled:text-lj-muted';
export const h2 = 'm-0 text-lg font-medium';
export const h3 = 'm-0 mt-5 text-base font-medium';
export const muted = 'm-0 mt-2 text-[0.875rem] text-lj-secondary';
export const field =
  'min-h-11 w-full rounded border border-lj-edge bg-transparent px-2 text-[0.875rem]';

/** A passage on a physical page. Page numbers are physical indexes, never printed labels. */
export interface Focus {
  readonly documentVersionId: string;
  readonly page: number;
  readonly start: number | null;
  readonly end: number | null;
}
