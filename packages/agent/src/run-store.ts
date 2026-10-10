/*
 * The run-store port and the capability record, without the server-only marker, so the
 * PostgreSQL implementation, its database tests and the smoke script can load them. It holds no
 * provider adapter, credential or prompt. ESLint keeps it out of browser code.
 */
export * from './runtime/run-store';
export * from './server/capability-record';
