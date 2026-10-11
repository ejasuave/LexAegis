import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { Readable } from 'node:stream';
import { isForbiddenHost, type CardTransport } from '@lexaegis/sdk/agent-identity';

/*
 * Node card transport that cannot be rebound: the hostname is resolved HERE, every returned address
 * must be public, and the validated address is the one the connection is made to (the hostname is
 * kept only for TLS server-name and certificate checks). No redirects, no cookies, no referrer, no
 * compression (so the byte limit is a decoded limit), no proxy variables.
 */
export function createPinnedNodeCardTransport(): CardTransport {
  return {
    async get(url, { signal }) {
      const target = new URL(url);
      const addresses = await lookup(target.hostname, { all: true, verbatim: true });
      if (addresses.length === 0 || addresses.some((entry) => isForbiddenHost(entry.address))) {
        throw new Error('DESTINATION_FORBIDDEN');
      }
      const pinned = addresses[0];
      if (pinned === undefined) throw new Error('DESTINATION_FORBIDDEN');
      return new Promise((resolve, reject) => {
        const outgoing = request(
          {
            host: pinned.address,
            servername: target.hostname,
            port: target.port === '' ? 443 : Number(target.port),
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            headers: {
              host: target.host,
              accept: 'application/json',
              'accept-encoding': 'identity',
            },
            agent: false,
            signal,
          },
          (response) => {
            resolve({
              status: response.statusCode ?? 0,
              redirected: false,
              body: Readable.toWeb(response) as ReadableStream<Uint8Array>,
            });
          },
        );
        outgoing.on('error', reject);
        outgoing.end();
      });
    },
  };
}
