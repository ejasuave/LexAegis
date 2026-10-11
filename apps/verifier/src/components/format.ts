export const KIB = 1024;
export function formatBytes(bytes: number): string {
  if (bytes < KIB) return `${String(bytes)} bytes`;
  if (bytes < KIB * KIB) return `${(bytes / KIB).toFixed(1)} KiB`;
  return `${(bytes / (KIB * KIB)).toFixed(1)} MiB`;
}

/** Decimal-string byte length to a short label, without going through Number for huge values. */
export function formatDecimalBytes(value: string): string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? formatBytes(parsed) : `${value} bytes`;
}
