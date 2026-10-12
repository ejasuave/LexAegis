# syntax=docker/dockerfile:1
# Build from the repository root. The bundle holds only deliberately public VITE_* configuration.
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @lexaegis/verifier...
ARG VITE_CHAIN_ID
ARG VITE_REGISTRY_ADDRESS
ARG VITE_RPC_URL
ARG VITE_RPC_ALLOWED_ORIGINS
RUN pnpm --filter @lexaegis/verifier build

FROM node:24-slim AS runtime
ARG RELEASE_ID=unset
ENV NODE_ENV=production PORT=8080 LEXAEGIS_RELEASE_ID=$RELEASE_ID
WORKDIR /srv
COPY --from=build --chown=node:node /repo/apps/verifier/dist ./dist
COPY --chown=node:node deploy/static-server.mjs ./static-server.mjs
USER node
EXPOSE 8080
CMD ["node", "static-server.mjs"]
