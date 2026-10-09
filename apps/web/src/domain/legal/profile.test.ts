import { describe, expect, it } from 'vitest';
import { parseReviewPackage, type ReviewPackageV1 } from '@lexaegis/protocol/v1';
import vectors from '../../../../../fixtures/protocol-v1/vectors.json';
import { checkLegalProfilePresence } from './profile';

function manifest(id: string): ReviewPackageV1 {
  const found = vectors.cases.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing vector ${id}`);
  const parsed = parseReviewPackage(structuredClone(found.opening.manifest));
  if (!parsed.ok) throw new Error(parsed.error.code);
  return structuredClone(parsed.data);
}

describe('legal profile presence check', () => {
  it('accepts the structurally complete synthetic legal packages', () => {
    for (const id of ['legal', 'legal-revised']) {
      expect(checkLegalProfilePresence(manifest(id))).toEqual({
        applicable: true,
        complete: true,
        missingRoles: [],
      });
    }
  });

  it('does not apply to other profiles or other versions of the legal profile', () => {
    expect(checkLegalProfilePresence(manifest('generic'))).toEqual({ applicable: false });
    const future = manifest('legal');
    future.profile.version = '2';
    expect(checkLegalProfilePresence(future)).toEqual({ applicable: false });
  });

  it('reports each missing required role', () => {
    const base = manifest('legal');
    for (const role of [
      'extracted-text',
      'analysis',
      'calculation',
      'rule-pack',
      'checklist',
      'agent-config',
    ] as const) {
      const partial = { ...base, artifacts: base.artifacts.filter((item) => item.role !== role) };
      expect(checkLegalProfilePresence(partial)).toEqual({
        applicable: true,
        complete: false,
        missingRoles: [role],
      });
    }
  });

  it('treats evidence attachments as optional', () => {
    const base = manifest('legal');
    expect(base.artifacts.some((item) => item.role === 'evidence')).toBe(false);
    expect(checkLegalProfilePresence(base)).toMatchObject({ complete: true });
  });

  it('is generic-protocol independent: a generic package is valid without any legal role', () => {
    // The protocol accepts the generic package; only the application-level check is profile-aware.
    expect(manifest('generic').artifacts.map((item) => item.role)).toEqual([
      'source',
      'decision-log',
    ]);
  });
});
