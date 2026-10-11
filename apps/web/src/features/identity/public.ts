/** The identity surface UI code may import. It reads one public route; it cannot sign, register or rate. */
export { AgentIdentityController, fetchIdentity } from './controller';
export type { IdentitySnapshot, IdentityPhase } from './controller';
export { describeView } from './describe';
export type { IdentityView } from './describe';
