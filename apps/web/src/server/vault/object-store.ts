import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/*
 * Private object storage for opaque ciphertext. Server-only: bucket credentials never reach the
 * browser. Keys are built from validated server-side ownership and opaque IDs, never from
 * user-supplied bucket names, paths, URLs or ACLs.
 */

export class ObjectStoreError extends Error {
  constructor(readonly kind: 'UNAVAILABLE' | 'UNCERTAIN') {
    super(kind);
    this.name = 'ObjectStoreError';
  }
}

export interface ObjectStore {
  /**
   * Creates the object only if the key does not exist. "exists" means the key was already taken;
   * the caller must compare the stored bytes before treating that as success. Throws
   * ObjectStoreError when the outcome is unknown. Never overwrites.
   */
  putIfAbsent(key: string, bytes: Uint8Array): Promise<'created' | 'exists'>;
  get(key: string): Promise<Uint8Array | null>;
}

export function objectKey(vaultId: string, objectId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(vaultId) || !/^[0-9a-f-]{36}$/.test(objectId)) {
    throw new TypeError('invalid object key parts');
  }
  return `vaults/${vaultId}/objects/${objectId}`;
}

export interface S3Settings {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

interface AwsLikeError {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

export function createS3ObjectStore(settings: S3Settings): ObjectStore {
  // A fixed configured endpoint, path-style addressing, and TLS unless the endpoint is loopback
  // (enforced by the server environment schema). No public ACL is ever requested.
  const client = new S3Client({
    endpoint: settings.endpoint,
    region: settings.region,
    forcePathStyle: true,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    maxAttempts: 2,
  });
  return {
    async putIfAbsent(key, bytes) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: settings.bucket,
            Key: key,
            Body: bytes,
            ContentType: 'application/json',
            ContentLength: bytes.byteLength,
            IfNoneMatch: '*',
          }),
        );
        return 'created';
      } catch (error) {
        const failure = error as AwsLikeError;
        if (failure.name === 'PreconditionFailed' || failure.$metadata?.httpStatusCode === 412) {
          return 'exists';
        }
        // 409 ConditionalRequestConflict and everything else: the outcome is not known.
        throw new ObjectStoreError(
          failure.$metadata?.httpStatusCode === 409 ? 'UNCERTAIN' : 'UNAVAILABLE',
        );
      }
    },
    async get(key) {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: settings.bucket, Key: key }),
        );
        return response.Body === undefined ? null : await response.Body.transformToByteArray();
      } catch (error) {
        const failure = error as AwsLikeError;
        if (failure.name === 'NoSuchKey' || failure.$metadata?.httpStatusCode === 404) return null;
        throw new ObjectStoreError('UNAVAILABLE');
      }
    },
  };
}

/**
 * Proves the provider really enforces conditional create, by writing a probe key twice. A
 * provider that ignores If-None-Match would silently overwrite, so storage is refused rather
 * than used. The two probe objects are 1 byte each and are not deleted.
 */
export async function probeConditionalCreate(
  store: ObjectStore,
  random: () => string,
): Promise<boolean> {
  try {
    const key = `probe/${random()}`;
    const first = await store.putIfAbsent(key, new Uint8Array([65]));
    const second = await store.putIfAbsent(key, new Uint8Array([66]));
    const stored = await store.get(key);
    return first === 'created' && second === 'exists' && stored?.length === 1 && stored[0] === 65;
  } catch {
    return false;
  }
}
