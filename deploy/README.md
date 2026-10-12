# Deployment

Operator notes for the release assets. Nothing here has been deployed: see `deploy/target.json`
(`status: unprovisioned`) and `docs/release/`.

- Images: `deploy/docker/web.Dockerfile` (Next.js standalone, Node runtime, non-root) and
  `deploy/docker/verifier.Dockerfile` (static assets and `deploy/static-server.mjs`). Build from the
  repository root. Public `NEXT_PUBLIC_*` / `VITE_*` values are build arguments; server secrets are
  runtime-only and must never be passed as `ARG`.
- Release: `pnpm release prepare|deploy|verify` (see `scripts/release.ts`). Rollback and restore:
  `pnpm release:rollback` (see Rollback below).
- Hosted checks: `pnpm hosted:smoke`. Submission: `pnpm submission:validate`.

## Rollback

`pnpm release:rollback --to <releaseId>` selects a previously recorded, tested release on the same
services, origins and rpId. It checks schema/configuration compatibility first and never downgrades a
database, restores chain state or overwrites private captures. Restore checks run in a disposable
namespace: `pnpm release:rollback --restore-check` (a synthetic local rehearsal of the verification logic on throwaway servers; `--corrupt` is its negative control). During an operational restore keep funding, broadcasts and new assistant work disabled, expire restored sessions and challenges, and reconcile pending operations read-only before allowing mutations. Rebuilding Envio state uses a new generation from the real start block; restoring ciphertext cannot recreate a deleted credential. Backups are private and bounded by the provider's
retention setting; none has been enabled yet.
