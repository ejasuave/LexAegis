import { describe, expect, it } from 'vitest';
import artifactRefFile from '../../schemas/v1/artifact-ref.schema.json';
import openingFile from '../../schemas/v1/commitment-opening.schema.json';
import descriptorFile from '../../schemas/v1/protocol-descriptor.json';
import referenceFile from '../../schemas/v1/receipt-reference.schema.json';
import packageFile from '../../schemas/v1/review-package.schema.json';
import { COMMITMENT_DOMAIN, LIMITS, PACKAGE_DOMAIN } from './constants';
import { PROTOCOL_DESCRIPTOR_V1 } from './descriptor';
import { buildGeneratedFiles, serializeGeneratedFile } from './json-schema';

const generated = buildGeneratedFiles();
const fresh = (name: keyof typeof generated): unknown =>
  JSON.parse(serializeGeneratedFile(generated[name]));

function objectNodes(
  node: unknown,
  found: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const item of node) objectNodes(item, found);
  } else if (node !== null && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (record.type === 'object') found.push(record);
    for (const value of Object.values(record)) objectNodes(value, found);
  }
  return found;
}

describe('generated protocol artifacts', () => {
  it('committed files equal what the implementation generates (no silent drift)', () => {
    expect(descriptorFile).toEqual(fresh('protocol-descriptor.json'));
    expect(artifactRefFile).toEqual(fresh('artifact-ref.schema.json'));
    expect(referenceFile).toEqual(fresh('receipt-reference.schema.json'));
    expect(packageFile).toEqual(fresh('review-package.schema.json'));
    expect(openingFile).toEqual(fresh('commitment-opening.schema.json'));
  });

  it('the descriptor records the constants the code actually uses', () => {
    expect(PROTOCOL_DESCRIPTOR_V1.domains.package).toBe(PACKAGE_DOMAIN);
    expect(PROTOCOL_DESCRIPTOR_V1.domains.commitment).toBe(COMMITMENT_DOMAIN);
    expect(PROTOCOL_DESCRIPTOR_V1.limits).toEqual(LIMITS);
    expect(PROTOCOL_DESCRIPTOR_V1.limits.maxJsonBytes).toBe(1_048_576);
    expect(PROTOCOL_DESCRIPTOR_V1.limits.maxArtifactBytes).toBe(10_485_760);
    expect(PROTOCOL_DESCRIPTOR_V1.limits.maxTotalArtifactBytes).toBe(33_554_432);
    expect(PROTOCOL_DESCRIPTOR_V1.disclosure.public).toEqual(['ReceiptReferenceV1']);
    expect(Object.isFrozen(PROTOCOL_DESCRIPTOR_V1.limits)).toBe(true);
  });

  it.each([
    ['artifact-ref', artifactRefFile],
    ['receipt-reference', referenceFile],
    ['review-package', packageFile],
    ['commitment-opening', openingFile],
  ])('%s is a closed draft 2020-12 schema with a stable identifier', (name, schema) => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe(`urn:lexaegis:protocol:v1:${name}`);
    const objects = objectNodes(schema);
    expect(objects.length).toBeGreaterThan(0);
    for (const node of objects) expect(node.additionalProperties).toBe(false);
  });
});
