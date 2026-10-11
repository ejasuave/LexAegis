"""Lists every function the deployed registry can reach, using Slither's own call graph.

Run by `pnpm contracts:static` inside the isolated analysis copy. It prints JSON on stdout:
{"contract": ..., "entryPoints": [...], "reachable": [canonical function names, sorted]}.
A dependency finding located in a function that is NOT in this list concerns code that is not part
of the registry's runtime behaviour (internal library code is only compiled in when it is called).
"""

import json
import sys

from slither import Slither

TARGET = "ProofOfReviewRegistry"


def main() -> int:
    slither = Slither(".")
    contracts = [c for c in slither.contracts if c.name == TARGET]
    if len(contracts) != 1:
        print(json.dumps({"error": "TARGET_NOT_FOUND"}))
        return 1
    contract = contracts[0]
    seen = set()
    stack = [f for f in contract.functions if f.is_implemented]
    entry = sorted(f.canonical_name for f in contract.functions_entry_points)
    while stack:
        function = stack.pop()
        if function.canonical_name in seen:
            continue
        seen.add(function.canonical_name)
        for call in function.internal_calls:
            callee = getattr(call, "function", call)
            if hasattr(callee, "canonical_name") and hasattr(callee, "internal_calls"):
                stack.append(callee)
        for call in function.library_calls:
            callee = getattr(call, "function", None)
            if callee is None and isinstance(call, tuple):
                callee = call[1]
            if callee is not None and hasattr(callee, "canonical_name"):
                stack.append(callee)
        for modifier in getattr(function, "modifiers", []):
            stack.append(modifier)
    print(json.dumps({"contract": TARGET, "entryPoints": entry, "reachable": sorted(seen)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
