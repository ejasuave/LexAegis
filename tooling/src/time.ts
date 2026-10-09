/** Every deadline carries an explicit Europe/London offset; instants are compared, never local strings. */
export function instant(iso: string): number {
  const value = Date.parse(iso);
  if (Number.isNaN(value) || !/(Z|[+-]\d{2}:\d{2})$/.test(iso)) {
    throw new Error(`timestamp needs an explicit offset: ${iso}`);
  }
  return value;
}

export function isAfter(now: string, deadline: string): boolean {
  return instant(now) > instant(deadline);
}

/** Inclusive: an instant exactly at the cutoff has not passed it. */
export function isAtOrBefore(now: string, deadline: string): boolean {
  return instant(now) <= instant(deadline);
}
