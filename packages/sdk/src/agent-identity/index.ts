/**
 * Read-only ERC-8004 agent identity: the resolver, its trusted-deployment policy, result schema and
 * the registration-file (card) format. Importing it makes no request; nothing here signs, registers
 * or gives feedback.
 */
export {
  AGENT_IDENTITY_RESOLUTION_SCHEMA,
  RESOLUTION_LIMITS,
  RESOLUTION_REASONS,
  agentIdentityPolicySchema,
  agentIdentityResolutionSchema,
  resolveAgentIdentity,
  type AgentIdentityPolicy,
  type AgentIdentityResolutionV1,
  type AgentIdentityTransport,
  type ResolutionReason,
  type ResolveInput,
} from './resolve';
export {
  createAgentIdentityRpcClient,
  type AgentIdentityChainClient,
  type ReadOutcome,
} from './rpc';
export {
  DISPLAY_LIMITS,
  REGISTRATION_TYPE,
  buildRegistrationFile,
  registrationFileSchema,
  type RegistrationFile,
  type RegistrationInput,
} from './registration-file';
