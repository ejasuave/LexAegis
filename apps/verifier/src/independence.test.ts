import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Static independence checks for the verifier's own sources. The runtime proofs (network blocked,
 * LexAegis backend, Qwen and Envio unavailable) are in the browser check.
 */

const src = fileURLToPath(new URL('.', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    const isCode =
      /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'test-helpers.ts';
    return isCode ? [path] : [];
  });
}

const files = sources(src).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
const everything = files.map((file) => file.text).join('\n');

describe('verifier independence', () => {
  it('has sources to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('imports nothing from the web app, agent, vault, account code or any private source path', () => {
    for (const { path, text } of files) {
      for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1] ?? '';
        expect(
          /^(?:@lexaegis\/(?:web|agent|vault)|@category-labs|@scure|next(?:\/|$)|server-only|@\/)|apps\/web|\/packages\/|\/src\/(?:features|server)\//.test(
            specifier,
          ),
          `${path} imports ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it('calls no LexAegis API, reads no backend configuration and uses no persistent storage', () => {
    for (const forbidden of [
      '/api/',
      'NEXT_PUBLIC_',
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'caches.',
      'serviceWorker',
      'document.cookie',
      'location.hash',
      'location.search',
      'history.pushState',
      'history.replaceState',
      'navigator.sendBeacon',
      'XMLHttpRequest',
      'WebSocket',
      'EventSource',
      'BroadcastChannel',
      'window.open',
      'ALCHEMY',
      'qwen',
      'envio',
      'DATABASE_URL',
    ]) {
      expect(everything.includes(forbidden), `verifier source mentions ${forbidden}`).toBe(false);
    }
  });

  it('makes no network call of its own: only the SDK transport reaches an explicit RPC endpoint', () => {
    for (const { path, text } of files) {
      expect(/(?<![.\w])fetch\s*\(/.test(text), `${path} calls fetch`).toBe(false);
    }
  });

  it('passes no private bytes through postMessage to anyone but its own worker', () => {
    const users = files.filter((file) => /postMessage/.test(file.text)).map((file) => file.path);
    expect(users.map((path) => path.replace(src, ''))).toEqual(
      expect.arrayContaining(['local-job.ts', 'verification-worker.ts']),
    );
    expect(users).toHaveLength(2);
  });

  it('renders labels and artifact text only as escaped text', () => {
    expect(everything).not.toContain('dangerouslySetInnerHTML');
    expect(everything).not.toContain('innerHTML');
    // The only address ever assigned is the temporary download address of the explicit Download.
    expect([...everything.matchAll(/\.href\s*=\s*([^;]+);/g)].map((m) => m[1]?.trim())).toEqual([
      'url',
    ]);
  });
});
