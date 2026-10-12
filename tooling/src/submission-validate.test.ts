import { describe, expect, it } from 'vitest';
import { mp4DurationSeconds } from '../scripts/validate-submission';

/** A minimal ftyp + moov(mvhd) file with the given timescale and duration. */
function mp4(version: 0 | 1, timescale: number, duration: number): Uint8Array {
  const body = new Uint8Array(version === 1 ? 100 : 100);
  const view = new DataView(body.buffer);
  body[0] = version;
  if (version === 1) {
    view.setUint32(20, timescale);
    view.setBigUint64(24, BigInt(duration));
  } else {
    view.setUint32(12, timescale);
    view.setUint32(16, duration);
  }
  const box = (name: string, payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(8 + payload.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(new TextEncoder().encode(name), 4);
    out.set(payload, 8);
    return out;
  };
  const moov = box('moov', box('mvhd', body));
  const ftyp = box('ftyp', new Uint8Array(8));
  const all = new Uint8Array(ftyp.length + moov.length);
  all.set(ftyp, 0);
  all.set(moov, ftyp.length);
  return all;
}

describe('mp4DurationSeconds', () => {
  it('reads version 0 and version 1 movie headers', () => {
    expect(mp4DurationSeconds(mp4(0, 1000, 175_000))).toBe(175);
    expect(mp4DurationSeconds(mp4(1, 600, 108_000))).toBe(180);
  });

  it('does not guess when the file is not an MP4', () => {
    expect(mp4DurationSeconds(new TextEncoder().encode('not a video at all'))).toBeNull();
    expect(mp4DurationSeconds(new Uint8Array(0))).toBeNull();
  });
});
