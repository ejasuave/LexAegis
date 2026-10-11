import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (match?.[1] === undefined) throw new Error(`missing token ${name}`);
  return match[1];
}
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('design tokens', () => {
  it('uses the blueprint palette', () => {
    expect(token('lj-bg')).toBe('#060b14');
    expect(token('lj-bg-soft')).toBe('#0c1626');
    expect(token('lj-raised')).toBe('#112039');
    expect(token('lj-border')).toBe('#23364c');
    expect(token('lj-text')).toBe('#e6edf7');
    expect(token('lj-text-secondary')).toBe('#aabcd0');
    expect(token('lj-cobalt-action')).toBe('#1d4ed8');
    expect(token('lj-violet-text')).toBe('#b6a1ff');
    expect(token('lj-amber')).toBe('#f5c76a');
    expect(token('lj-positive')).toBe('#69d8a7');
    expect(token('lj-error')).toBe('#fda4af');
  });

  it('keeps every text pairing at WCAG AA (4.5:1) on every surface', () => {
    const surfaces = ['lj-bg', 'lj-bg-soft', 'lj-raised'].map(token);
    const texts = [
      'lj-text',
      'lj-text-secondary',
      'lj-text-muted',
      'lj-cyan',
      'lj-violet-text',
      'lj-amber',
      'lj-error',
      'lj-positive',
    ].map((name) => [name, token(name)] as const);
    for (const surface of surfaces) {
      for (const [name, color] of texts) {
        expect(contrast(color, surface), `${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps filled action buttons readable and control edges visible', () => {
    expect(contrast(token('lj-text'), token('lj-cobalt-action'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('lj-control-edge'), token('lj-bg'))).toBeGreaterThanOrEqual(3);
    expect(contrast(token('lj-focus'), token('lj-bg-soft'))).toBeGreaterThanOrEqual(3);
  });
});
