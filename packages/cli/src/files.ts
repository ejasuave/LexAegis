import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export type ReadResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | {
      readonly ok: false;
      readonly code: 'INPUT_UNREADABLE' | 'INPUT_NOT_A_REGULAR_FILE' | 'INPUT_TOO_LARGE';
    };

/**
 * Reads one local regular file, bounded: the size is checked on the open handle (no race with a
 * path swap) before any byte is read, a FIFO or device is refused without blocking, and growth
 * past the limit while reading is detected. Paths are used exactly as given: nothing in an
 * imported file is ever treated as a path.
 */
export async function readBoundedFile(path: string, maxBytes: number): Promise<ReadResult> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return { ok: false, code: 'INPUT_UNREADABLE' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, code: 'INPUT_NOT_A_REGULAR_FILE' };
    if (info.size > maxBytes) return { ok: false, code: 'INPUT_TOO_LARGE' };
    const buffer = new Uint8Array(info.size + 1);
    let filled = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
      if (bytesRead === 0) break;
      filled += bytesRead;
      if (filled > info.size) return { ok: false, code: 'INPUT_TOO_LARGE' };
    }
    return { ok: true, bytes: buffer.slice(0, filled) };
  } catch {
    return { ok: false, code: 'INPUT_UNREADABLE' };
  } finally {
    await handle.close();
  }
}
