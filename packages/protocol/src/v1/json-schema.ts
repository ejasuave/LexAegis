import { z } from 'zod';
import { PROTOCOL_DESCRIPTOR_V1 } from './descriptor';
import {
  artifactRefV1Schema,
  commitmentOpeningV1Schema,
  receiptReferenceV1Schema,
  reviewPackageV1Schema,
} from './schemas';

const PACKAGE_RULES =
  'Runtime rules not expressible here: valid UTC calendar date; chainId <= 2^256-1; label <= 256 Unicode code points without lone surrogates; artifact byteLength <= 10485760 and combined <= 33554432; unique artifact ids; at least one source and exactly one decision-log artifact; scopeArtifactIds unique and covering every artifact exactly once; decisionLogArtifactId resolving to the decision-log artifact; supersedes chain/registry/reviewer equal to context.';

const DEFINITIONS = [
  {
    file: 'artifact-ref.schema.json',
    id: 'urn:lexaegis:protocol:v1:artifact-ref',
    title: 'ArtifactRefV1',
    schema: artifactRefV1Schema,
    comment:
      'PRIVATE. Runtime rules not expressible here: byteLength <= 10485760; label <= 256 Unicode code points without lone surrogates.',
  },
  {
    file: 'receipt-reference.schema.json',
    id: 'urn:lexaegis:protocol:v1:receipt-reference',
    title: 'ReceiptReferenceV1',
    schema: receiptReferenceV1Schema,
    comment:
      'PUBLIC projection. It identifies an intended receipt and does not establish that one exists. Runtime rule not expressible here: chainId <= 2^256-1.',
  },
  {
    file: 'review-package.schema.json',
    id: 'urn:lexaegis:protocol:v1:review-package',
    title: 'ReviewPackageV1',
    schema: reviewPackageV1Schema,
    comment: `PRIVATE. ${PACKAGE_RULES}`,
  },
  {
    file: 'commitment-opening.schema.json',
    id: 'urn:lexaegis:protocol:v1:commitment-opening',
    title: 'CommitmentOpeningV1',
    schema: commitmentOpeningV1Schema,
    comment: `PRIVATE opening material. ${PACKAGE_RULES}`,
  },
] as const;

export type GeneratedFileName = (typeof DEFINITIONS)[number]['file'] | 'protocol-descriptor.json';

/**
 * JSON Schema draft 2020-12 documents generated from the source Zod schemas, plus the protocol
 * descriptor. Objects are closed (additionalProperties: false). Rules that JSON Schema cannot
 * express stay enforced at runtime and are listed in each document's $comment.
 */
export function buildGeneratedFiles(): Record<GeneratedFileName, unknown> {
  const files: Partial<Record<GeneratedFileName, unknown>> = {
    'protocol-descriptor.json': PROTOCOL_DESCRIPTOR_V1,
  };
  for (const definition of DEFINITIONS) {
    const { $schema, ...body } = z.toJSONSchema(definition.schema, { target: 'draft-2020-12' });
    files[definition.file] = {
      $schema,
      $id: definition.id,
      title: definition.title,
      $comment: definition.comment,
      ...body,
    };
  }
  return files as Record<GeneratedFileName, unknown>;
}

/** Exact file content: two-space JSON with a trailing newline. */
export function serializeGeneratedFile(content: unknown): string {
  return `${JSON.stringify(content, null, 2)}\n`;
}
