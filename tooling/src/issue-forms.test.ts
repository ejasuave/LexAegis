import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/*
 * Local validation of the GitHub issue forms against the documented issue-forms syntax (checked
 * 2026-10-12: https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms).
 * It proves the YAML shape only. A real hosted submission is separate evidence that does not exist yet.
 */

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const FORMS = ['integration-request.yml', 'integration-report.yml'] as const;
const TYPES = new Set(['markdown', 'textarea', 'input', 'dropdown', 'checkboxes']);
const TOP_LEVEL = new Set([
  'name',
  'description',
  'title',
  'labels',
  'assignees',
  'projects',
  'type',
  'body',
]);

interface Element {
  type: string;
  id?: string;
  attributes?: Record<string, unknown>;
  validations?: Record<string, unknown>;
}
const load = (name: string): Record<string, unknown> =>
  parse(readFileSync(join(root, '.github', 'ISSUE_TEMPLATE', name), 'utf8')) as Record<
    string,
    unknown
  >;

describe.each(FORMS)('%s', (file) => {
  const form = load(file);
  const body = form.body as Element[];

  it('has the required top-level keys and nothing that assigns people or names labels', () => {
    expect(typeof form.name).toBe('string');
    expect(typeof form.description).toBe('string');
    expect(Array.isArray(body)).toBe(true);
    for (const key of Object.keys(form)) expect(TOP_LEVEL.has(key), key).toBe(true);
    expect(form.labels).toBeUndefined();
    expect(form.assignees).toBeUndefined();
    expect(form.projects).toBeUndefined();
  });

  it('uses valid element types, unique ids and unique labels', () => {
    const ids = new Set<string>();
    const labels = new Set<string>();
    for (const element of body) {
      expect(TYPES.has(element.type), element.type).toBe(true);
      if (element.type === 'markdown') {
        expect(element.id).toBeUndefined();
        expect(element.validations).toBeUndefined();
        expect(((element.attributes?.value as string | undefined) ?? '').length).toBeGreaterThan(
          20,
        );
        continue;
      }
      expect(element.id, 'id').toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(ids.has(element.id ?? ''), `duplicate id ${element.id ?? ''}`).toBe(false);
      ids.add(element.id ?? '');
      const label = (element.attributes?.label as string | undefined) ?? '';
      expect(label.length).toBeGreaterThan(0);
      expect(labels.has(label), `duplicate label ${label}`).toBe(false);
      labels.add(label);
    }
  });

  it('has valid dropdown and checkbox options and at least one required field', () => {
    let required = 0;
    for (const element of body) {
      if (element.type === 'dropdown') {
        const options = element.attributes?.options as string[];
        expect(options.length).toBeGreaterThan(0);
        expect(new Set(options).size).toBe(options.length);
        expect(options).not.toContain('None');
      }
      if (element.type === 'checkboxes') {
        const options = element.attributes?.options as { label: string; required?: boolean }[];
        for (const option of options) {
          expect(typeof option.label).toBe('string');
          if (option.required === true) required += 1;
        }
      }
      if (element.validations?.required === true) required += 1;
    }
    expect(required).toBeGreaterThan(0);
  });

  it('forbids sensitive material in public text, in the notice and in a required checkbox', () => {
    const text = JSON.stringify(body);
    expect(text).toMatch(/client documents, private openings, keys, tokens or usable signatures/);
    const checkbox = body.find((element) => element.type === 'checkboxes');
    const options = checkbox?.attributes?.options as { label: string; required?: boolean }[];
    expect(
      options.some(
        (option) => option.required === true && /no client documents/.test(option.label),
      ),
    ).toBe(true);
  });

  it('says a submission is self-reported, not verified adoption, and points at the traction-log rules', () => {
    const notice = body.find((element) => element.type === 'markdown')?.attributes?.value as string;
    expect(notice).toMatch(/not\*\* verified adoption|not verified adoption/i);
    expect(notice).toContain('docs/adoption/traction-log.md');
    expect(existsSync(join(root, 'docs', 'adoption', 'traction-log.md'))).toBe(true);
  });
});

describe('the pair', () => {
  it('asks the questions the request and the report need', () => {
    const request = (load('integration-request.yml').body as Element[]).map(
      (element) => element.id,
    );
    expect(request).toEqual(
      expect.arrayContaining([
        'use-case',
        'environment',
        'package-versions',
        'desired-integration',
        'blocker',
        'assistance-request',
      ]),
    );
    const report = (load('integration-report.yml').body as Element[]).map((element) => element.id);
    expect(report).toEqual(
      expect.arrayContaining([
        'attempted',
        'version-network',
        'observed',
        'reproduction',
        'evidence',
        'assistance',
      ]),
    );
  });
});
