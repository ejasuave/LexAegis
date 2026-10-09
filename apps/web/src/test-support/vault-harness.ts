/**
 * lexaegis-test-only
 * TEST SUPPORT. The real account controller, real vault controller, real vault service and real
 * Web Crypto, joined in memory with a scripted authenticator, clock and storage doubles. Storage
 * contracts are checked against real PostgreSQL and a real S3-compatible server elsewhere
 * (vault-storage.pgtest.ts and pnpm test:account:browser).
 */
import { randomUUID } from 'node:crypto';
import protocolVectors from '../../../../fixtures/protocol-v1/vectors.json';
import { prepareReviewPackage, type PreparedReviewPackage } from '@lexaegis/protocol/v1';
import { KeySink } from '@/features/vault/key-sink';
import { createVaultTransport } from '@/features/vault/transport';
import { VaultController } from '@/features/vault/vault-controller';
import { createVaultService, type VaultService } from '@/server/vault/service';
import { Backend, CONFIG, Clock, createHarness, type HarnessOptions } from './account-harness';
import { MemoryObjectStore, MemoryVaultRepository } from './memory-vault';

export interface Faults {
  /** The server processes the next write, then the response is lost: the client cannot know. */
  loseNextWriteResponse: boolean;
  /** The server never receives the next write. */
  dropNextWrite: boolean;
  /** Rewrites a GET response for a path matching this predicate. */
  offline: boolean;
  /** The next object-write acknowledgement reports a digest that is not the one sent. */
  tamperNextPutDigest: boolean;
}

/** Everything a deployment shares between devices: the database and the object store. */
export interface SharedServer {
  readonly repo: MemoryVaultRepository;
  readonly objects: MemoryObjectStore;
}
export const newServer = (): SharedServer => ({
  repo: new MemoryVaultRepository(),
  objects: new MemoryObjectStore(),
});

export interface VaultHarnessOptions extends HarnessOptions {
  server?: SharedServer;
  /** The request log shared across devices, for sentinel scans. */
  log?: { requests: string[]; responses: string[] };
}

export function createVaultHarness(options: VaultHarnessOptions = {}) {
  const sink = new KeySink();
  const clock = options.clock ?? new Clock();
  const server = options.server ?? newServer();
  const log = options.log ?? { requests: [], responses: [] };
  const base = createHarness({ ...options, clock, vaultConsumer: sink.consume });
  const service: VaultService = createVaultService({
    repo: server.repo,
    objects: server.objects,
    rpId: CONFIG.rpId,
    now: () => new Date(clock.now),
    randomId: () => randomUUID(),
    allow: () => Promise.resolve(true),
  });
  const faults: Faults = {
    loseNextWriteResponse: false,
    dropNextWrite: false,
    offline: false,
    tamperNextPutDigest: false,
  };

  const fetcher = async (path: string, init: RequestInit): Promise<Response> => {
    if (faults.offline) throw new TypeError('network down');
    const method = init.method ?? 'GET';
    const write = method === 'PUT' || method === 'POST';
    if (write && faults.dropNextWrite) {
      faults.dropNextWrite = false;
      throw new TypeError('request never reached the server');
    }
    const session = await base.backend.service.session(base.backend.cookieHeader());
    if (typeof session === 'string')
      return new Response('{"ok":false,"error":{"code":"UNAUTHENTICATED","requestId":"r"}}', {
        status: 401,
      });
    const body =
      init.body === undefined || init.body === null
        ? new Uint8Array()
        : typeof init.body === 'string'
          ? new TextEncoder().encode(init.body)
          : new Uint8Array(init.body as ArrayBuffer);
    if (write) log.requests.push(new TextDecoder().decode(body.slice(0, 4000)));
    const parts = new URL(path, 'https://app.lexaegis.test').pathname.split('/').filter(Boolean); // api vault [id] head|objects [oid]
    const [, , vaultId, kind, objectId] = parts;
    const address = session.address;
    let reply;
    if (vaultId === undefined)
      reply =
        method === 'GET'
          ? await service.discover(address, 'r')
          : await service.create(address, body, 'r');
    else if (kind === 'head')
      reply =
        method === 'GET'
          ? await service.getHead(address, vaultId, 'r')
          : await service.putHead(address, vaultId, body, 'r');
    else if (kind === 'objects' && objectId !== undefined) {
      reply =
        method === 'GET'
          ? await service.getObject(address, vaultId, objectId, 'r')
          : await service.putObject(address, vaultId, objectId, body, 'r');
    } else return new Response('{}', { status: 404 });
    if (write && faults.loseNextWriteResponse) {
      faults.loseNextWriteResponse = false;
      throw new TypeError('response lost');
    }
    if (reply.kind === 'bytes') return new Response(reply.bytes as BodyInit, { status: 200 });
    let text = JSON.stringify(reply.body);
    if (faults.tamperNextPutDigest && kind === 'objects' && method === 'PUT') {
      faults.tamperNextPutDigest = false;
      text = text.replace(/[0-9a-f]{64}/, '0'.repeat(64));
    }
    log.responses.push(text);
    return new Response(text, { status: reply.status });
  };

  const vault = new VaultController({
    rpId: CONFIG.rpId,
    account: {
      snapshot: base.controller.getSnapshot,
      unlockVault: () => base.controller.unlockVault(),
      onLock: (listener) => base.controller.onLock(listener),
    },
    sink,
    transport: createVaultTransport(fetcher),
    now: () => clock.now,
    newId: () => randomUUID(),
  });
  return { ...base, vault, sink, server, service, faults, log, clock };
}

export type VaultHarness = ReturnType<typeof createVaultHarness>;

interface ProtocolCase {
  readonly id: string;
  readonly artifacts: readonly { readonly id: string; readonly bytesBase64: string }[];
  readonly opening: { readonly manifest: unknown };
}
const protocolCases = (protocolVectors as unknown as { cases: readonly ProtocolCase[] }).cases;

/** A real Chapter 2 snapshot from a synthetic case, with a fresh blinding nonce. */
export async function prepareSynthetic(
  id: 'generic' | 'legal' | 'legal-revised' = 'legal',
): Promise<PreparedReviewPackage> {
  const found = protocolCases.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  const bytes = new Map(
    found.artifacts.map((a) => [
      a.id,
      Uint8Array.from(atob(a.bytesBase64), (c) => c.charCodeAt(0)),
    ]),
  );
  const prepared = await prepareReviewPackage(found.opening.manifest, bytes);
  if (!prepared.ok) throw new Error(prepared.error.code);
  return prepared.data;
}

/** Signs in and creates the vault, ready for tests. */
export async function withVault(harness: VaultHarness) {
  const signedIn = await harness.controller.createAndSignIn();
  if (!signedIn.ok) throw new Error(`sign-in failed: ${signedIn.code}`);
  const found = await harness.vault.refreshDiscovery();
  if (!found.ok) throw new Error(`discovery failed: ${found.failure}`);
  const made = await harness.vault.createVault();
  if (!made.ok) throw new Error(`create failed: ${made.failure}`);
  return harness;
}

export { Backend };
