import { z } from 'zod';

/** Cursor contents are untrusted input and never authorisation: every field is re-checked. */
const MAX_BYTES = 2048;

export const cursorSchema = z.strictObject({
  v: z.literal(1),
  fp: z.string().regex(/^0x[0-9a-f]{64}$/),
  gen: z.string().regex(/^[a-z0-9][a-z0-9-]{7,63}$/),
  r: z.string().regex(/^0x[0-9a-f]{40}$/),
  upper: z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
  upperHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  last: z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
  lastHash: z.string().regex(/^0x[0-9a-f]{64}$/),
});
export type HistoryCursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: HistoryCursor): string {
  const text = Buffer.from(JSON.stringify(cursorSchema.parse(cursor)), 'utf8').toString(
    'base64url',
  );
  if (text.length > MAX_BYTES) throw new Error('CURSOR_TOO_LARGE');
  return text;
}

export function decodeCursor(text: string): HistoryCursor | null {
  if (text.length === 0 || text.length > MAX_BYTES || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(text, 'base64url').toString('utf8')),
    );
    if (!parsed.success) return null;
    // Re-encode and compare so non-canonical encodings of the same value are rejected.
    return encodeCursor(parsed.data) === text ? parsed.data : null;
  } catch {
    return null;
  }
}
