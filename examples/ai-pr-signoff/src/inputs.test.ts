import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readBoundedFile } from './inputs.js';

const directory = mkdtempSync(join(tmpdir(), 'signoff-inputs-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('bounded inputs', () => {
  it('reads a regular file', () => {
    writeFileSync(join(directory, 'a'), 'abc');
    expect(readBoundedFile(join(directory, 'a'), 10)).toEqual({
      ok: true,
      bytes: new TextEncoder().encode('abc'),
    });
  });

  it('refuses oversized, empty, directory and symlinked inputs', () => {
    writeFileSync(join(directory, 'big'), 'x'.repeat(11));
    writeFileSync(join(directory, 'empty'), '');
    mkdirSync(join(directory, 'dir'));
    symlinkSync(join(directory, 'big'), join(directory, 'link'));
    expect(readBoundedFile(join(directory, 'big'), 10)).toEqual({ ok: false, code: 'TOO_LARGE' });
    expect(readBoundedFile(join(directory, 'empty'), 10)).toEqual({ ok: false, code: 'EMPTY' });
    expect(readBoundedFile(join(directory, 'dir'), 10)).toEqual({
      ok: false,
      code: 'NOT_REGULAR_FILE',
    });
    expect(readBoundedFile(join(directory, 'link'), 100)).toEqual({
      ok: false,
      code: 'UNREADABLE',
    });
    expect(readBoundedFile(join(directory, 'missing'), 10)).toEqual({
      ok: false,
      code: 'UNREADABLE',
    });
  });
});
