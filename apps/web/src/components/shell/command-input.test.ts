import { describe, expect, it } from 'vitest';
import { decideEnter, type EnterContext } from './command-input';

const ctx = (patch: Partial<EnterContext> = {}): EnterContext => ({
  key: 'Enter',
  shiftKey: false,
  isComposing: false,
  draft: 'check payments',
  busy: false,
  available: true,
  ...patch,
});

describe('composer Enter handling', () => {
  it('sends on plain Enter with a draft', () => expect(decideEnter(ctx())).toBe('send'));
  it('inserts a newline on Shift+Enter', () =>
    expect(decideEnter(ctx({ shiftKey: true }))).toBe('newline'));
  it('never sends while an input method is composing', () => {
    expect(decideEnter(ctx({ isComposing: true }))).toBe('newline');
    expect(decideEnter(ctx({ key: 'Process' }))).toBe('newline');
  });
  it('ignores Enter for a blank draft, a running request or a missing assistant', () => {
    expect(decideEnter(ctx({ draft: '   ' }))).toBe('ignore');
    expect(decideEnter(ctx({ busy: true }))).toBe('ignore');
    expect(decideEnter(ctx({ available: false }))).toBe('ignore');
  });
  it('leaves other keys alone', () => expect(decideEnter(ctx({ key: 'a' }))).toBe('newline'));
});
