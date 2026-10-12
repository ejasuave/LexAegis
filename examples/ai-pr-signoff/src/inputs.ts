import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/*
 * Every input is inert bytes: nothing is executed, interpreted as a path or fetched. Each file must
 * be a regular file (no symlink, device or directory) within a stated size bound, read through one
 * descriptor so the size checked is the size read.
 */

export const INPUT_LIMITS = Object.freeze({
  diff: 2 * 1024 * 1024,
  summary: 256 * 1024,
  decision: 64 * 1024,
});

export type InputFailure = 'NOT_REGULAR_FILE' | 'TOO_LARGE' | 'EMPTY' | 'UNREADABLE';

export type InputResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: InputFailure };

export function readBoundedFile(path: string, maxBytes: number): InputResult {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { ok: false, code: 'UNREADABLE' };
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return { ok: false, code: 'NOT_REGULAR_FILE' };
    if (stat.size > maxBytes) return { ok: false, code: 'TOO_LARGE' };
    if (stat.size === 0) return { ok: false, code: 'EMPTY' };
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    // The file shrank or grew while it was read: the snapshot is not the file.
    if (offset !== bytes.length || fstatSync(descriptor).size !== bytes.length)
      return { ok: false, code: 'UNREADABLE' };
    return { ok: true, bytes };
  } catch {
    return { ok: false, code: 'UNREADABLE' };
  } finally {
    closeSync(descriptor);
  }
}
