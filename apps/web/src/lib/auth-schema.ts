import { z } from 'zod';
import { chainIdSchema, nonZeroAddressSchema } from '@lexaegis/protocol/v1';

/** Public response shapes of the auth routes, shared by the server and the browser client. */
export const sessionViewSchema = z.strictObject({
  address: nonZeroAddressSchema,
  chainId: chainIdSchema,
  expiresAt: z.string().max(40),
});
export type SessionView = z.infer<typeof sessionViewSchema>;

export const challengeViewSchema = z.strictObject({
  challengeId: z.string().regex(/^[0-9a-f]{32}$/),
  message: z.string().max(2000),
  expiresAt: z.string().max(40),
});
export type ChallengeView = z.infer<typeof challengeViewSchema>;

export const REQUEST_HEADER = 'X-LexAegis-Request';
