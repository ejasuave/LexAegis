# Independent Python checker for the protocol v1 vectors

`verify_vectors.py` re-implements the offline parts of Proof of Review in the Python **standard
library only**. It exists to show that the written specification, not the TypeScript code, is enough
to reproduce every digest, commitment, canonical byte sequence and verification result.

It does **not** run Node, import the TypeScript implementation, call a service, or treat an expected
value as a computed one. It makes **no network call** and claims **no live registry, signature or
chain verification**. Constants (domains, limits, patterns, roles) are read from `docs/SPEC.md`.

## Supported JSON subset

`null`, booleans, valid Unicode strings, arrays, objects with unique string keys, and plain integer
tokens that are safe integers. It rejects fractions and exponents, non-finite values, unsafe
integers, lexical negative zero, lone surrogates, comments, trailing commas or content, a byte-order
mark, malformed UTF-8, the member names `__proto__`, `constructor` and `prototype`, duplicate names
(also after escape decoding) and nesting beyond 32 containers. Decimals stay strings.

This is a verifier for the protocol's constrained subset, **not** a general-purpose RFC 8785
implementation. Members are sorted by UTF-16 code unit (Python's default code-point order would be
wrong for characters above U+FFFF).

## Run

```sh
python3 -I examples/python-verify/verify_vectors.py            # failures and a summary line
python3 -I examples/python-verify/verify_vectors.py --table    # every case
pnpm interop:python                                            # also compares with the TypeScript outcomes
pnpm test:python                                               # the checker's own tests
```

Exit status `0` means every case agreed (with the frozen expectation and, when given, the
TypeScript outcomes); `1` means a disagreement; `2` means unusable input. Output names case IDs and
codes only, never artifact content or openings.

`--ts-outcomes FILE` takes the JSON written by `pnpm --filter @lexaegis/protocol vectors:ts-outcomes`.
No case is skipped as unsupported: an unknown operation is an error.

## What the tests prove

`test_verify_vectors.py` shows the checker agrees with every published case **and** that it detects
an altered expected digest, an altered domain separator, a UTF-16 ordering mistake, acceptance of
duplicate keys, a rejection at the wrong stage and a disagreement with TypeScript. It also asserts
the script imports only the standard library and no network, process or Node facilities.

Test-only: every address, nonce and document in the vectors is synthetic. Fixed opening nonces are
not production randomness.
