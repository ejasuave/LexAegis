# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f deploy/docker/web.Dockerfile --build-arg RELEASE_ID=<id> .
# Only the public, non-secret NEXT_PUBLIC_* values are build arguments. Server secrets are read at
# runtime by the service and never enter an ARG, a layer or the build log.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @lexaegis/web...
ARG NEXT_PUBLIC_APP_ORIGIN
ARG NEXT_PUBLIC_VERIFIER_ORIGIN
ARG NEXT_PUBLIC_WEBAUTHN_RP_ID
ARG NEXT_PUBLIC_CHAIN_ID
ARG NEXT_PUBLIC_REGISTRY_ADDRESS
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @lexaegis/web build

FROM node:24-slim AS runtime
ARG RELEASE_ID=unset
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 LEXAEGIS_RELEASE_ID=$RELEASE_ID
WORKDIR /srv
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
