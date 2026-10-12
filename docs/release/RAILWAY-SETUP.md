# Railway setup (operator steps)

Why the live site does nothing today: the web service runs with **no environment variables**, no
PostgreSQL, no object store and no provider keys, so `/api/readiness` reports every capability as
`NOT_CONFIGURED` and sign-in answers 503. The code is not at fault; the services behind it do not exist.

Never paste a secret into chat, a commit or a screenshot. Enter values only in the Railway dashboard.

## Web service (`terrific-joy-production-54e8`)

The repository's `railway.json` selects `deploy/docker/web.Dockerfile`, runs `node migrate.mjs` before each
deploy, and uses `/api/health` as the health check (one replica).

1. **Add PostgreSQL**: project canvas, New, Database, PostgreSQL.
2. **Add a Bucket** (New, Bucket) for encrypted vault objects. Keep it private.
3. In the web service, Variables, add these. **Build-time (public) values must exist before the build; change
   one and you must redeploy.**

   | Variable                                                                            | Value                                                                    |
   | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
   | `NEXT_PUBLIC_APP_ORIGIN`                                                            | `https://terrific-joy-production-54e8.up.railway.app`                    |
   | `NEXT_PUBLIC_WEBAUTHN_RP_ID`                                                        | `terrific-joy-production-54e8.up.railway.app`                            |
   | `NEXT_PUBLIC_CHAIN_ID`                                                              | `10143`                                                                  |
   | `NEXT_PUBLIC_REGISTRY_ADDRESS`                                                      | `0x453bfd1602d8a8666f55bf9a8d87b127cb94048f`                             |
   | `NEXT_PUBLIC_VERIFIER_ORIGIN`                                                       | the verifier service URL (below)                                         |
   | `DATABASE_URL`                                                                      | reference the Postgres service variable (private network URL)            |
   | `AUTH_SESSION_SECRET`                                                               | a new random value, for example the output of `openssl rand -hex 32`     |
   | `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | from the Bucket's variables                                              |
   | `ALCHEMY_MONAD_RPC_URL`                                                             | your Alchemy Monad Testnet URL (secret)                                  |
   | `QWEN_API_KEY`, `QWEN_BASE_URL`, `QWEN_MODEL`                                       | `QWEN_MODEL` is `qwen3.8-max`; copy the other two from your local `.env` |
   | `ENVIO_GRAPHQL_URL`                                                                 | the hosted Envio GraphQL URL (see Envio below)                           |

   Do **not** add `TESTNET_DEPLOYER_PRIVATE_KEY`. `TESTNET_FUNDER_PRIVATE_KEY` and `TESTNET_FUNDING_ENABLED=true`
   are optional and make the server send testnet MON to users; add them only if you accept that.

4. **Passkey identity warning.** Passkeys are bound to the host in `NEXT_PUBLIC_WEBAUTHN_RP_ID`. If this
   `*.up.railway.app` host ever changes (service deleted or recreated), every passkey created on it stops
   working. Use a custom domain you control if the demo must outlive this service.
5. Deploy, then `curl https://terrific-joy-production-54e8.up.railway.app/api/readiness`. `configured` means
   present, not verified.

## Verifier service (separate origin)

1. New service from the same GitHub repo. Settings, Config-as-code file path: `/railway.verifier.json`.
2. Variables (public, build-time): `VITE_CHAIN_ID=10143`,
   `VITE_REGISTRY_ADDRESS=0x453bfd1602d8a8666f55bf9a8d87b127cb94048f`, `VITE_RPC_URL=https://testnet-rpc.monad.xyz/`.
3. Generate a domain, then put it in the web service's `NEXT_PUBLIC_VERIFIER_ORIGIN` and redeploy the web service.

## Envio indexer

Railway does not run this. Deploy `indexer/` on Envio's hosted service (docs: hosted-service-deployment), set
`ENVIO_API_TOKEN` there, then copy its **read** GraphQL URL into `ENVIO_GRAPHQL_URL`. Until then history reads
report unavailable, which is the honest state.
