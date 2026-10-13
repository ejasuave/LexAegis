import { describe, expect, it } from 'vitest';
import { availableCommands, filterCommands, resolveInput, suggestCommand } from './hud.commands';

const entries = availableCommands({ matterBriefing: false });

describe('command registry', () => {
  it('lists the blueprint commands, hides /brief until its feature is on, always has /stop', () => {
    const names = entries.map((e) => e.command);
    for (const c of [
      '/explain',
      '/check-payments',
      '/status',
      '/stop',
      '/missing-evidence',
      '/summarise',
      '/prepare-review',
    ]) {
      expect(names).toContain(c);
    }
    expect(names).not.toContain('/brief');
    expect(availableCommands({ matterBriefing: true }).map((e) => e.command)).toContain('/brief');
  });

  it('has no command that approves, signs, freezes, broadcasts or executes', () => {
    for (const entry of availableCommands({ matterBriefing: true })) {
      expect(entry.command).not.toMatch(
        /approve|sign|freeze|broadcast|submit|revoke|exec|run|shell/,
      );
    }
  });

  it('filters by prefix first, then by title, and lists all on an empty query', () => {
    expect(filterCommands(entries, '').length).toBe(entries.length);
    expect(filterCommands(entries, 'ex')[0]?.command).toBe('/explain');
    expect(filterCommands(entries, '/check')[0]?.command).toBe('/check-payments');
    expect(filterCommands(entries, 'package').map((e) => e.command)).toContain('/prepare-review');
    expect(filterCommands(entries, 'zzzz')).toEqual([]);
  });

  it('suggests the nearest command for a typo and nothing for nonsense', () => {
    expect(suggestCommand(entries, '/expain')?.command).toBe('/explain');
    expect(suggestCommand(entries, '/summarize')?.command).toBe('/summarise');
    expect(suggestCommand(entries, '/qqqqqqqqqqqqqqq')).toBeNull();
  });
});

describe('resolving typed input', () => {
  it('sends /stop straight to cancellation, whatever its case or spacing', () => {
    expect(resolveInput(entries, '/stop').kind).toBe('stop');
    expect(resolveInput(entries, '  /STOP ').kind).toBe('stop');
  });

  it('resolves explicit commands, with their arguments, to registry entries', () => {
    const r = resolveInput(entries, '/explain clause 4');
    expect(r.kind).toBe('command');
    if (r.kind === 'command') expect(r.entry.command).toBe('/explain');
  });

  it('hands free text to the dock instead of running it', () => {
    expect(resolveInput(entries, 'what does this clause mean in practice?').kind).toBe('text');
    expect(resolveInput(entries, 'please check the payments').kind).toBe('text');
  });

  it('refuses approval and signing requests however they are worded', () => {
    for (const phrase of [
      'approve this package',
      'sign it',
      'yes approve',
      'please submit',
      'freeze the package',
    ]) {
      expect(resolveInput(entries, phrase).kind).toBe('refused');
    }
    expect(resolveInput(entries, '/approve').kind).toBe('unknown');
    expect(resolveInput(entries, '/sign').kind).toBe('unknown');
  });

  it('gives an unknown command a suggestion, never an execution', () => {
    const r = resolveInput(entries, '/expain');
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.suggestion?.command).toBe('/explain');
    expect(resolveInput(entries, '/rm -rf /').kind).toBe('unknown');
    expect(resolveInput(entries, '').kind).toBe('empty');
  });

  it('does not offer /brief when its feature is off', () => {
    expect(resolveInput(entries, '/brief').kind).toBe('unknown');
  });
});
