import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readBoundedFile } from './files';

const directory = mkdtempSync(join(tmpdir(), 'cli-files-'));
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('bounded local file reads', () => {
  it('reads a regular file exactly, and follows a symlink to a regular file', async () => {
    writeFileSync(join(directory, 'a.bin'), Buffer.from([1, 2, 3]));
    symlinkSync(join(directory, 'a.bin'), join(directory, 'link.bin'));
    expect(await readBoundedFile(join(directory, 'a.bin'), 10)).toEqual({
      ok: true,
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(await readBoundedFile(join(directory, 'link.bin'), 10)).toMatchObject({ ok: true });
  });

  it('refuses a missing path, a directory and a FIFO without blocking', async () => {
    expect(await readBoundedFile(join(directory, 'missing'), 10)).toEqual({
      ok: false,
      code: 'INPUT_UNREADABLE',
    });
    mkdirSync(join(directory, 'dir'));
    expect(await readBoundedFile(join(directory, 'dir'), 10)).toEqual({
      ok: false,
      code: 'INPUT_NOT_A_REGULAR_FILE',
    });
    execFileSync('mkfifo', [join(directory, 'fifo')]);
    expect(await readBoundedFile(join(directory, 'fifo'), 10)).toEqual({
      ok: false,
      code: 'INPUT_NOT_A_REGULAR_FILE',
    });
  });

  it('checks the size before reading', async () => {
    writeFileSync(join(directory, 'big.bin'), Buffer.alloc(11));
    expect(await readBoundedFile(join(directory, 'big.bin'), 10)).toEqual({
      ok: false,
      code: 'INPUT_TOO_LARGE',
    });
    expect(await readBoundedFile(join(directory, 'big.bin'), 11)).toMatchObject({ ok: true });
  });

  it('treats a label that looks like a path as plain data: only the explicit argument is opened', async () => {
    writeFileSync(join(directory, 'real.bin'), Buffer.from('x'));
    expect(
      await readBoundedFile(join(directory, '..', '..', 'etc', 'passwd-label'), 10),
    ).toMatchObject({ ok: false });
  });
});
