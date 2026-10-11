/**
 * Drift check for docs/SPEC.md. Every tagged literal, list, table, pattern and field table in the
 * specification is compared with the value derived from the implementation, the registry source,
 * the committed ABI artifact and the independent fixtures. It never writes or regenerates an
 * expected value, and it never compares the specification with another copy of itself.
 *
 * Tags are HTML comments that follow the text they describe:
 *   <!-- spec:literal NAME -->   the last inline code span before the tag on the same line
 *   <!-- spec:pattern NAME -->   as literal, for a regular expression (table-cell pipes unescaped)
 *   <!-- spec:list NAME -->      the first code span of each following bullet
 *   <!-- spec:table NAME -->     the next table: first column key, second column value
 *   <!-- spec:fields NAME -->    the next table: first column is the ordered field list
 *   <!-- spec:snippet NAME -->   the next ```ts fence: type-checked and executed
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, toHex } from 'viem';
import { z } from 'zod';
import {
  APPROVAL_INTENT,
  ARTIFACT_ROLES,
  COMMITMENT_DOMAIN,
  LIMITS,
  OPENING_SCHEMA,
  PACKAGE_DOMAIN,
  PACKAGE_SCHEMA,
  PROTOCOL_DESCRIPTOR_V1,
  PROTOCOL_ERROR_CODES,
  REFERENCE_SCHEMA,
  addressSchema,
  artifactRefV1Schema,
  chainIdSchema,
  commitmentOpeningV1Schema,
  digestSchema,
  mediaTypeSchema,
  profileIdSchema,
  profileVersionSchema,
  receiptReferenceV1Schema,
  reviewPackageV1Schema,
  unsignedDecimalSchema,
  uuidSchema,
} from '@lexaegis/protocol/v1';
import {
  PORTABLE_ERROR_CODES,
  PORTABLE_LIMITS,
  REVIEW_EXPORT_SCHEMA,
  reviewExportSchema,
} from '@lexaegis/protocol/portable';
import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  RECEIPT_STATUS_ORDER,
  REGISTRY_PROTOCOL_VERSION,
  REVIEW_ACTION_CODES,
  REVIEW_ACTION_FIELDS,
  REVIEW_ACTION_PRIMARY_TYPE,
  REVIEW_ACTION_TYPE_STRING,
} from '../src/registry/constants';
import { proofOfReviewRegistryAbi } from '../src/registry/generated/registry-abi';
import { LIVE_BUDGET_LIMITS } from '../src/registry/budget';
import { RPC_METHODS } from '../src/registry/rpc-client';
import { REPORT_ISSUE_CODES, VERIFICATION_MODES } from '../src/verification/report';

export interface SpecFinding {
  readonly tag: string;
  readonly message: string;
}

export interface SpecOptions {
  /** Repository root (contains contracts/, fixtures/ and docs/). */
  readonly root: string;
  /** Type-check and run the ```ts snippets. */
  readonly snippets: boolean;
  /** Package directory the snippets are written under, so workspace packages resolve. */
  readonly snippetDir?: string;
}

/** Tags a complete specification must carry; deleting a tag is itself a finding. */
export const REQUIRED_TAGS: readonly string[] = [
  'literal:PACKAGE_SCHEMA',
  'literal:REFERENCE_SCHEMA',
  'literal:OPENING_SCHEMA',
  'literal:REVIEW_EXPORT_SCHEMA',
  'literal:APPROVAL_INTENT',
  'literal:PACKAGE_DOMAIN',
  'literal:COMMITMENT_DOMAIN',
  'literal:ARTIFACT_DIGEST_FORMULA',
  'literal:REGISTRY_PROTOCOL_VERSION',
  'literal:EIP712_NAME',
  'literal:EIP712_VERSION',
  'literal:EIP712_DOMAIN_TYPE',
  'literal:EIP712_PRIMARY_TYPE',
  'literal:EIP712_TYPE_STRING',
  'literal:EIP712_TYPE_HASH',
  'literal:ISSUE_VECTOR_DIGEST',
  'pattern:uuid',
  'pattern:address',
  'pattern:digest',
  'pattern:unsignedDecimal',
  'pattern:chainId',
  'pattern:profileId',
  'pattern:mediaType',
  'list:ARTIFACT_ROLES',
  'list:RECEIPT_STATUS',
  'list:REGISTRY_EVENTS',
  'list:REGISTRY_ERRORS',
  'list:VERIFICATION_MODES',
  'list:RPC_METHODS',
  'list:REPORT_ISSUE_CODES',
  'list:PROTOCOL_ERROR_CODES',
  'list:PORTABLE_ERROR_CODES',
  'table:ACTION_CODES',
  'table:LIMITS',
  'table:PORTABLE_LIMITS',
  'table:LIVE_BUDGET',
  'fields:ArtifactRefV1',
  'fields:ReviewPackageV1',
  'fields:ReviewPackageV1.profile',
  'fields:ReviewPackageV1.context',
  'fields:ReviewPackageV1.approval',
  'fields:CommitmentOpeningV1',
  'fields:ReceiptReferenceV1',
  'fields:ReviewExportV1',
  'fields:ReviewAction',
  'snippet:reproduce-generic',
  'snippet:implementation-generic',
];

type TagKind = 'literal' | 'pattern' | 'list' | 'table' | 'fields' | 'snippet';
interface Tag {
  readonly kind: TagKind;
  readonly name: string;
  readonly line: number;
}

const TAG = /<!--\s*spec:(literal|pattern|list|table|fields|snippet)\s+([A-Za-z0-9_.-]+)\s*-->/g;
const CODE_SPAN = /`([^`]+)`/g;

function codeSpans(text: string): string[] {
  return [...text.matchAll(CODE_SPAN)].map((match) => match[1] ?? '');
}

/** Table-cell content with the escaped pipe restored. */
const unescapeCell = (value: string): string => value.replaceAll('\\|', '|');

function cells(row: string): string[] {
  // Split on pipes that are not escaped; the leading and trailing pipe produce empty ends.
  const parts = row.trim().split(/(?<!\\)\|/);
  return parts.slice(1, -1).map((part) => part.trim());
}

function followingTable(lines: readonly string[], from: number): string[][] | null {
  let index = from;
  while (index < lines.length && (lines[index] ?? '').trim() === '') index += 1;
  const rows: string[][] = [];
  while (index < lines.length && (lines[index] ?? '').trim().startsWith('|')) {
    rows.push(cells(lines[index] ?? ''));
    index += 1;
  }
  // Drop the header and the separator row.
  return rows.length >= 3 ? rows.slice(2) : null;
}

function followingList(lines: readonly string[], from: number): string[] {
  let index = from;
  while (index < lines.length && (lines[index] ?? '').trim() === '') index += 1;
  const items: string[] = [];
  while (index < lines.length && /^\s*-\s/.test(lines[index] ?? '')) {
    const [first] = codeSpans(lines[index] ?? '');
    items.push(first ?? '');
    index += 1;
  }
  return items;
}

function followingFence(lines: readonly string[], from: number): string | null {
  let index = from;
  while (index < lines.length && (lines[index] ?? '').trim() === '') index += 1;
  if (!/^```ts\b/.test(lines[index] ?? '')) return null;
  const body: string[] = [];
  index += 1;
  while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
    body.push(lines[index] ?? '');
    index += 1;
  }
  return body.join('\n');
}

// ---- Source-derived expectations ----------------------------------------------------------------

interface Sources {
  readonly literals: Readonly<Record<string, string>>;
  readonly patterns: Readonly<Record<string, string>>;
  readonly lists: Readonly<Record<string, { ordered: boolean; values: readonly string[] }>>;
  readonly tables: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly fields: Readonly<Record<string, readonly { name: string; type?: string | undefined }[]>>;
  /** Disagreements among the independent sources themselves (blockers, not doc drift). */
  readonly sourceDisagreements: readonly string[];
}

const read = (root: string, path: string): string => readFileSync(join(root, path), 'utf8');

function jsonSchemaProperties(schema: z.ZodType, path: readonly string[] = []): string[] {
  let node = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  for (const key of path) {
    const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
    const next = properties?.[key];
    if (next === undefined) return [];
    node = next;
  }
  return Object.keys((node.properties as Record<string, unknown> | undefined) ?? {});
}

function jsonSchemaPattern(schema: z.ZodType): string {
  const node = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as { pattern?: string };
  return node.pattern ?? '';
}

function solidityEnum(source: string, name: string): string[] {
  const match = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(source);
  return (match?.[1] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function solidityStruct(source: string, name: string): { name: string; type: string }[] {
  const match = new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`).exec(source);
  return (match?.[1] ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const [type = '', field = ''] = part.split(/\s+/);
      return { name: field, type };
    });
}

function solidityConstants(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of source.matchAll(/uint8\s+internal\s+constant\s+(\w+)\s*=\s*(\d+);/g)) {
    out[match[1] ?? ''] = match[2] ?? '';
  }
  return out;
}

const abiTypeName = (input: { type: string }): string => input.type;

function deriveSources(root: string): Sources {
  const disagreements: string[] = [];
  const registrySource = read(root, 'contracts/src/ProofOfReviewRegistry.sol');
  const authorizationSource = read(root, 'contracts/src/ReviewAuthorization.sol');
  const interfaceSource = read(root, 'contracts/src/interfaces/IProofOfReviewRegistry.sol');
  const artifact = JSON.parse(read(root, 'contracts/artifacts/registry-v1.json')) as {
    protocolVersion: string;
    actionCodes: Record<string, number>;
    receiptStatus: string[];
    eip712: {
      domain: { name: string; version: string };
      domainTypeString: string;
      primaryType: string;
      typeString: string;
      typeHash: string;
    };
  };
  const registryVectors = JSON.parse(read(root, 'fixtures/registry-v1/vectors.json')) as {
    eip712: { domainTypeString: string; typeString: string; typeHash: string };
    vectors: { id: string; expected: { digest: string } }[];
  };

  const must = (condition: boolean, message: string): void => {
    if (!condition) disagreements.push(message);
  };

  // Registry facts read from the Solidity text, then cross-checked against every other source.
  const typeString =
    /REVIEW_ACTION_TYPEHASH\s*=\s*keccak256\(\s*"([^"]+)"/.exec(authorizationSource)?.[1] ?? '';
  const domain = /EIP712\("([^"]+)",\s*"([^"]+)"\)/.exec(authorizationSource);
  const solidityName = domain?.[1] ?? '';
  const solidityVersion = domain?.[2] ?? '';
  const typeHash = keccak256(toHex(typeString));
  const protocolVersionSource = /function protocolVersion\(\)[^{]*\{\s*return\s+(\d+);/.exec(
    registrySource,
  )?.[1];
  const statusSource = solidityEnum(interfaceSource, 'ReceiptStatus');
  const actionSource = solidityConstants(interfaceSource);

  must(typeString === REVIEW_ACTION_TYPE_STRING, 'type string: Solidity differs from the SDK');
  must(
    typeString === artifact.eip712.typeString,
    'type string: Solidity differs from the artifact',
  );
  must(
    typeString === registryVectors.eip712.typeString,
    'type string: Solidity differs from the registry vectors',
  );
  must(typeHash === artifact.eip712.typeHash, 'type hash: Solidity differs from the artifact');
  must(
    typeHash === registryVectors.eip712.typeHash,
    'type hash: Solidity differs from the vectors',
  );
  must(solidityName === EIP712_DOMAIN_NAME, 'domain name: Solidity differs from the SDK');
  must(solidityName === artifact.eip712.domain.name, 'domain name: Solidity differs from artifact');
  must(solidityVersion === EIP712_DOMAIN_VERSION, 'domain version: Solidity differs from the SDK');
  must(solidityVersion === artifact.eip712.domain.version, 'domain version: differs from artifact');
  must(
    artifact.eip712.domainTypeString === registryVectors.eip712.domainTypeString,
    'domain type: artifact differs from the vectors',
  );
  must(
    protocolVersionSource === REGISTRY_PROTOCOL_VERSION &&
      artifact.protocolVersion === REGISTRY_PROTOCOL_VERSION,
    'protocol version: Solidity, artifact and SDK differ',
  );
  must(
    JSON.stringify(statusSource) === JSON.stringify(artifact.receiptStatus),
    'receipt status order: Solidity differs from the artifact',
  );
  const sameCodes = (record: Record<string, string | number>): boolean =>
    Object.keys(record).length === Object.keys(actionSource).length &&
    Object.entries(actionSource).every(([key, value]) => String(record[key]) === value);
  must(
    sameCodes(artifact.actionCodes) && sameCodes(REVIEW_ACTION_CODES),
    'action codes: Solidity, artifact and SDK differ',
  );
  must(
    RECEIPT_STATUS_ORDER.join(',') ===
      statusSource.map((name) => name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()).join(','),
    'receipt status: the SDK lifecycle order differs from Solidity',
  );

  const abiEvents = proofOfReviewRegistryAbi
    .filter((item) => item.type === 'event' && item.name !== 'EIP712DomainChanged')
    .map((item) => `${item.name}(${item.inputs.map(abiTypeName).join(',')})`);
  const inheritedErrors = new Set(['InvalidShortString', 'StringTooLong']);
  const abiErrors = proofOfReviewRegistryAbi
    .filter((item) => item.type === 'error' && !inheritedErrors.has(item.name))
    .map((item) => `${item.name}(${item.inputs.map(abiTypeName).join(',')})`);
  const sourceErrors = [...interfaceSource.matchAll(/^\s*error\s+(\w+)\(([^)]*)\);/gm)].map(
    (match) => {
      const types = (match[2] ?? '')
        .split(',')
        .map((part) => part.trim().split(/\s+/)[0] ?? '')
        .filter((part) => part !== '')
        .map((type) => (type === 'ReceiptStatus' ? 'uint8' : type));
      return `${match[1] ?? ''}(${types.join(',')})`;
    },
  );
  must(
    JSON.stringify([...abiErrors].sort()) === JSON.stringify([...sourceErrors].sort()),
    'registry errors: the interface differs from the generated ABI',
  );

  const issueVector = registryVectors.vectors.find((vector) => vector.id === 'issue');

  const stringify = (record: Record<string, number>): Record<string, string> =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, String(value)]));

  return {
    literals: {
      PACKAGE_SCHEMA,
      REFERENCE_SCHEMA,
      OPENING_SCHEMA,
      REVIEW_EXPORT_SCHEMA,
      APPROVAL_INTENT,
      PACKAGE_DOMAIN,
      COMMITMENT_DOMAIN,
      ARTIFACT_DIGEST_FORMULA: PROTOCOL_DESCRIPTOR_V1.formulas.artifactDigest,
      REGISTRY_PROTOCOL_VERSION: protocolVersionSource ?? '',
      EIP712_NAME: solidityName,
      EIP712_VERSION: solidityVersion,
      EIP712_DOMAIN_TYPE: artifact.eip712.domainTypeString,
      EIP712_PRIMARY_TYPE: REVIEW_ACTION_PRIMARY_TYPE,
      EIP712_TYPE_STRING: typeString,
      EIP712_TYPE_HASH: typeHash,
      ISSUE_VECTOR_DIGEST: issueVector?.expected.digest ?? '',
    },
    patterns: {
      uuid: jsonSchemaPattern(uuidSchema),
      address: jsonSchemaPattern(addressSchema),
      digest: jsonSchemaPattern(digestSchema),
      blindingNonce: jsonSchemaPattern(digestSchema),
      unsignedDecimal: jsonSchemaPattern(unsignedDecimalSchema),
      chainId: jsonSchemaPattern(chainIdSchema),
      profileId: jsonSchemaPattern(profileIdSchema),
      profileVersion: jsonSchemaPattern(profileVersionSchema),
      mediaType: jsonSchemaPattern(mediaTypeSchema),
    },
    lists: {
      ARTIFACT_ROLES: { ordered: true, values: ARTIFACT_ROLES },
      RECEIPT_STATUS: { ordered: true, values: statusSource },
      REGISTRY_EVENTS: { ordered: false, values: abiEvents },
      REGISTRY_ERRORS: { ordered: false, values: sourceErrors },
      VERIFICATION_MODES: { ordered: true, values: VERIFICATION_MODES },
      RPC_METHODS: { ordered: true, values: RPC_METHODS },
      REPORT_ISSUE_CODES: { ordered: true, values: REPORT_ISSUE_CODES },
      PROTOCOL_ERROR_CODES: { ordered: true, values: PROTOCOL_ERROR_CODES },
      PORTABLE_ERROR_CODES: { ordered: true, values: PORTABLE_ERROR_CODES },
    },
    tables: {
      ACTION_CODES: actionSource,
      LIMITS: stringify(LIMITS),
      PORTABLE_LIMITS: stringify(PORTABLE_LIMITS),
      LIVE_BUDGET: stringify(LIVE_BUDGET_LIMITS),
    },
    fields: {
      ArtifactRefV1: jsonSchemaProperties(artifactRefV1Schema).map((name) => ({ name })),
      ReviewPackageV1: jsonSchemaProperties(reviewPackageV1Schema).map((name) => ({ name })),
      'ReviewPackageV1.profile': jsonSchemaProperties(reviewPackageV1Schema, ['profile']).map(
        (name) => ({ name }),
      ),
      'ReviewPackageV1.context': jsonSchemaProperties(reviewPackageV1Schema, ['context']).map(
        (name) => ({ name }),
      ),
      'ReviewPackageV1.approval': jsonSchemaProperties(reviewPackageV1Schema, ['approval']).map(
        (name) => ({ name }),
      ),
      CommitmentOpeningV1: jsonSchemaProperties(commitmentOpeningV1Schema).map((name) => ({
        name,
      })),
      ReceiptReferenceV1: jsonSchemaProperties(receiptReferenceV1Schema).map((name) => ({ name })),
      ReviewExportV1: jsonSchemaProperties(reviewExportSchema).map((name) => ({ name })),
      ReviewAction: solidityStruct(interfaceSource, 'ReviewAction').map(({ name, type }) => ({
        name,
        type,
      })),
    },
    sourceDisagreements: [
      ...disagreements,
      ...(JSON.stringify(REVIEW_ACTION_FIELDS.map((f) => [f.name, f.type])) ===
      JSON.stringify(solidityStruct(interfaceSource, 'ReviewAction').map((f) => [f.name, f.type]))
        ? []
        : ['review action fields: the SDK differs from Solidity']),
    ],
  };
}

// ---- Comparison ---------------------------------------------------------------------------------

function sameList(
  expected: { ordered: boolean; values: readonly string[] },
  actual: readonly string[],
): boolean {
  if (expected.values.length !== actual.length) return false;
  const left = expected.ordered ? [...expected.values] : [...expected.values].sort();
  const right = expected.ordered ? [...actual] : [...actual].sort();
  return left.every((value, index) => value === right[index]);
}

function checkTag(tag: Tag, lines: readonly string[], sources: Sources): SpecFinding[] {
  const id = `${tag.kind}:${tag.name}`;
  const finding = (message: string): SpecFinding[] => [
    { tag: `${id} (line ${String(tag.line + 1)})`, message },
  ];
  const line = lines[tag.line] ?? '';
  switch (tag.kind) {
    case 'literal':
    case 'pattern': {
      const expected =
        tag.kind === 'literal' ? sources.literals[tag.name] : sources.patterns[tag.name];
      if (expected === undefined) return finding('no source value is registered for this tag');
      const tagStart = line.search(/<!--\s*spec:/);
      const spans = codeSpans(line.slice(0, tagStart === -1 ? undefined : tagStart));
      const documented = spans.at(-1);
      if (documented === undefined) return finding('no inline code value precedes the tag');
      const actual = tag.kind === 'pattern' ? unescapeCell(documented) : documented;
      return actual === expected
        ? []
        : finding(`documented "${actual}" but the source has "${expected}"`);
    }
    case 'list': {
      const expected = sources.lists[tag.name];
      if (expected === undefined) return finding('no source list is registered for this tag');
      const actual = followingList(lines, tag.line + 1);
      return sameList(expected, actual)
        ? []
        : finding(
            `documented ${String(actual.length)} items differ from the source's ${String(expected.values.length)}`,
          );
    }
    case 'table': {
      const expected = sources.tables[tag.name];
      if (expected === undefined) return finding('no source table is registered for this tag');
      const rows = followingTable(lines, tag.line + 1);
      if (rows === null) return finding('no table follows the tag');
      const documented = Object.fromEntries(
        rows.map((row) => [codeSpans(row[0] ?? '')[0] ?? '', codeSpans(row[1] ?? '')[0] ?? '']),
      );
      const out: SpecFinding[] = [];
      for (const [key, value] of Object.entries(expected)) {
        if (documented[key] !== value) {
          out.push(
            ...finding(
              `"${key}" documented as "${documented[key] ?? '(absent)'}", source "${value}"`,
            ),
          );
        }
      }
      for (const key of Object.keys(documented)) {
        if (!(key in expected))
          out.push(...finding(`"${key}" is documented but absent from the source`));
      }
      return out;
    }
    case 'fields': {
      const expected = sources.fields[tag.name];
      if (expected === undefined) return finding('no source schema is registered for this tag');
      const rows = followingTable(lines, tag.line + 1);
      if (rows === null) return finding('no table follows the tag');
      const documentedNames = rows.map((row) => codeSpans(row[0] ?? '')[0] ?? '');
      const expectedNames = expected.map((entry) => entry.name);
      const out: SpecFinding[] = [];
      if (JSON.stringify(documentedNames) !== JSON.stringify(expectedNames)) {
        out.push(
          ...finding(
            `fields [${documentedNames.join(', ')}] differ from the source [${expectedNames.join(', ')}] (order matters)`,
          ),
        );
      }
      expected.forEach((entry, index) => {
        if (entry.type === undefined) return;
        const type = codeSpans(rows[index]?.[1] ?? '')[0];
        if (type !== entry.type) {
          out.push(
            ...finding(`field "${entry.name}" typed "${type ?? '(none)'}", source "${entry.type}"`),
          );
        }
      });
      return out;
    }
    case 'snippet':
      return [];
  }
}

/** Compiles and runs the tagged snippets. Everything written is removed afterwards. */
function checkSnippets(
  snippets: readonly { name: string; code: string; line: number }[],
  directory: string,
): SpecFinding[] {
  const findings: SpecFinding[] = [];
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        extends: '../tsconfig.json',
        compilerOptions: { noEmit: true, types: ['node'], noUnusedLocals: false },
        include: ['*.ts'],
      }),
    );
    for (const snippet of snippets)
      writeFileSync(join(directory, `${snippet.name}.ts`), snippet.code);

    const compile = spawnSync('pnpm', ['exec', 'tsc', '--noEmit', '-p', directory], {
      encoding: 'utf8',
    });
    if (compile.status !== 0) {
      findings.push({
        tag: 'snippet:compile',
        message: `type check failed: ${compile.stdout.split('\n').slice(0, 6).join(' | ')}`,
      });
      return findings;
    }
    for (const snippet of snippets) {
      const run = spawnSync('pnpm', ['exec', 'tsx', join(directory, `${snippet.name}.ts`)], {
        encoding: 'utf8',
      });
      if (run.status !== 0) {
        findings.push({
          tag: `snippet:${snippet.name} (line ${String(snippet.line + 1)})`,
          message: `execution failed: ${(run.stderr || run.stdout).split('\n').slice(0, 4).join(' | ')}`,
        });
      }
    }
    return findings;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Checks the specification text. Pure with respect to the repository: nothing is written. */
export function checkSpec(markdown: string, options: SpecOptions): SpecFinding[] {
  const lines = markdown.split('\n');
  const tags: Tag[] = [];
  lines.forEach((text, index) => {
    for (const match of text.matchAll(TAG)) {
      tags.push({ kind: match[1] as TagKind, name: match[2] ?? '', line: index });
    }
  });

  const findings: SpecFinding[] = [];
  const present = new Set(tags.map((tag) => `${tag.kind}:${tag.name}`));
  for (const required of REQUIRED_TAGS) {
    if (!present.has(required)) {
      findings.push({ tag: required, message: 'a required tag is missing from SPEC.md' });
    }
  }

  const revision = /source revision `([0-9a-f]{7,40})`/.exec(markdown)?.[1];
  if (revision === undefined) {
    findings.push({ tag: 'revision', message: 'SPEC.md does not name a source revision' });
  } else {
    const known = spawnSync('git', ['cat-file', '-e', `${revision}^{commit}`], {
      cwd: options.root,
    });
    if (known.status !== 0) {
      findings.push({
        tag: 'revision',
        message: `source revision ${revision} is not a known commit`,
      });
    }
  }

  const sources = deriveSources(options.root);
  for (const message of sources.sourceDisagreements) {
    findings.push({ tag: 'sources', message: `sources disagree: ${message}` });
  }
  for (const tag of tags) findings.push(...checkTag(tag, lines, sources));

  if (options.snippets) {
    const snippets = tags
      .filter((tag) => tag.kind === 'snippet')
      .flatMap((tag) => {
        const code = followingFence(lines, tag.line + 1);
        return code === null ? [] : [{ name: tag.name, code, line: tag.line }];
      });
    for (const tag of tags.filter((candidate) => candidate.kind === 'snippet')) {
      if (!snippets.some((snippet) => snippet.name === tag.name)) {
        findings.push({ tag: `snippet:${tag.name}`, message: 'no ```ts fence follows the tag' });
      }
    }
    if (snippets.length > 0) {
      findings.push(
        ...checkSnippets(
          snippets,
          options.snippetDir ?? join(options.root, 'packages', 'sdk', '.spec-snippets'),
        ),
      );
    }
  }
  return findings;
}
