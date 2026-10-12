# examples/embed: the widget on a plain HTML page

A local example. It uses a **throwaway local chain**, a locally deployed copy of the unchanged
registry and **synthetic** receipts. Nothing here is a Monad deployment or a live receipt, and a
reference from a previous run is meaningless: the chain is new every time.

```sh
pnpm install --frozen-lockfile
pnpm contracts:toolchain          # once: the pinned Foundry/Anvil (see contracts/README)
pnpm embed:example                # build the widget, start Anvil, issue receipts, serve
# open the printed http://127.0.0.1:5180/index.html (EMBED_EXAMPLE_PORT changes the port)
```

`index.html` is a **template**: the setup script fills in the real local references and writes a
runnable copy to the git-ignored `generated/`. The integration itself is two lines:

```html
<script type="module" src="./register.js"></script>
<proof-of-review-status
  chain-id="…"
  registry="…"
  reviewer="…"
  commitment="…"
></proof-of-review-status>
```

`generated/register.js` is the visible prerequisite: it imports the built bundle and passes the host's
trusted configuration (the local registry's deployment record and RPC endpoint). No application,
backend, login or indexer is involved. The page shows an active, a revoked, a superseded and a never
issued receipt, created by real local transactions, and a second active widget with a `package-url`
whose **Check files** button downloads the deliberately public synthetic package on request.

The local signer is Anvil's published development key. It lives in the test harness
(`contracts/integration/`), is used only to sign these synthetic receipts, and is not in the bundle.
The automated check is `contracts/integration/embed-example.anvil.test.ts`.
