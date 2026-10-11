"""Tests for the independent checker: it must agree with the vectors AND catch deliberate mistakes."""

import ast
import copy
import os
import sys
import unittest

import verify_vectors as v

with open(v.DEFAULT_SPEC, encoding="utf-8") as handle:
    SPEC = v.Spec(handle.read())
VECTORS = v.load_json(v.DEFAULT_VECTORS)
HERE = os.path.dirname(os.path.abspath(__file__))


def failures(vectors, engine):
    return {case["id"]: problems for case, _actual, problems in v.run_all(vectors, engine) if problems}


class Agreement(unittest.TestCase):
    def test_every_case_agrees_with_the_frozen_expectation(self):
        self.assertEqual(failures(VECTORS, v.Engine(SPEC)), {})

    def test_goldens_are_recomputed(self):
        self.assertEqual(v.check_goldens(VECTORS, v.Engine(SPEC)), [])

    def test_required_case_families_are_present(self):
        ids = {case["id"] for case in VECTORS["cases"]}
        for needed in ("neg-duplicate-key", "neg-duplicate-key-escaped", "canon-non-bmp-order", "verify-altered-artifact-byte"):
            self.assertIn(needed, ids)

    def test_constants_come_from_the_specification(self):
        self.assertEqual(SPEC.literals["PACKAGE_DOMAIN"], VECTORS["domains"]["package"])
        self.assertEqual(SPEC.literals["COMMITMENT_DOMAIN"], VECTORS["domains"]["commitment"])
        self.assertEqual(SPEC.limit("maxArtifacts"), 128)


class MistakesAreDetected(unittest.TestCase):
    def test_altered_expected_digest_byte(self):
        tampered = copy.deepcopy(VECTORS)
        case = next(c for c in tampered["cases"] if c["operation"] == "artifact-digest")
        digest = case["expected"]["digest"]
        case["expected"]["digest"] = digest[:-1] + ("0" if digest[-1] != "0" else "1")
        self.assertIn(case["id"], failures(tampered, v.Engine(SPEC)))

    def test_altered_golden_package_digest(self):
        tampered = copy.deepcopy(VECTORS)
        golden = tampered["goldens"][0]["expected"]
        golden["packageDigest"] = golden["packageDigest"][:-1] + ("0" if golden["packageDigest"][-1] != "0" else "1")
        self.assertTrue(v.check_goldens(tampered, v.Engine(SPEC)))

    def test_altered_domain_separator_changes_every_digest(self):
        with open(v.DEFAULT_SPEC, encoding="utf-8") as handle:
            spec = v.Spec(handle.read())
        spec.literals["PACKAGE_DOMAIN"] = "lexaegis:review-package:v2"
        bad = failures(VECTORS, v.Engine(spec))
        self.assertIn("generic-package-digest", bad)
        self.assertIn("generic-verify-full", bad)

    def test_utf16_sorting_mistake(self):
        # Code-point order puts U+FF5E before U+1F600; UTF-16 code-unit order puts the emoji first.
        bad = failures(VECTORS, v.Engine(SPEC, key_order="codepoint"))
        self.assertIn("canon-non-bmp-order", bad)

    def test_accepting_duplicate_keys(self):
        bad = failures(VECTORS, v.Engine(SPEC, reject_duplicates=False))
        self.assertIn("neg-duplicate-key", bad)
        self.assertIn("neg-duplicate-key-escaped", bad)

    def test_rejection_at_the_wrong_stage_is_not_a_pass(self):
        tampered = copy.deepcopy(VECTORS)
        case = next(c for c in tampered["cases"] if c["id"] == "neg-duplicate-key")
        case["stage"] = "schema"
        case["expected"]["stage"] = "schema"
        self.assertIn("wrong-stage", failures(tampered, v.Engine(SPEC))["neg-duplicate-key"])

    def test_disagreement_with_typescript_is_reported(self):
        ts = {case["id"]: v.run_case(v.Engine(SPEC), case) for case in VECTORS["cases"]}
        ts["generic-package-digest"] = {"outcome": "ok", "digest": "0x" + "00" * 32}
        results = {c["id"]: p for c, _a, p in v.run_all(VECTORS, v.Engine(SPEC), ts) if p}
        self.assertEqual(results, {"generic-package-digest": ["differs-from-typescript"]})

    def test_a_case_is_never_skipped_as_unsupported(self):
        unknown = {"id": "x", "stage": "schema", "operation": "no-such-operation", "input": {}, "expected": {"outcome": "ok"}}
        with self.assertRaises(ValueError):
            v.run_case(v.Engine(SPEC), unknown)


class JsonSubset(unittest.TestCase):
    def parse(self, text):
        return v.parse_strict(text.encode("utf-8"), SPEC)

    def code(self, text):
        with self.assertRaises(v.Reject) as caught:
            self.parse(text)
        return caught.exception.code

    def test_numbers(self):
        self.assertEqual(self.parse("[0,-1,9007199254740991]"), [0, -1, 9007199254740991])
        self.assertEqual(self.code("[1.5]"), "UNSAFE_NUMBER")
        self.assertEqual(self.code("[1e3]"), "UNSAFE_NUMBER")
        self.assertEqual(self.code("[-0]"), "UNSAFE_NUMBER")
        self.assertEqual(self.code("[9007199254740992]"), "UNSAFE_NUMBER")
        self.assertEqual(self.code("[01]"), "INVALID_JSON")
        self.assertEqual(self.code("[NaN]"), "INVALID_JSON")
        self.assertEqual(self.code("[Infinity]"), "INVALID_JSON")

    def test_lexical(self):
        for text in ("[1,]", '{"a":1,}', "[1] x", "// c\n[1]", '{"a" 1}', "['a']", '["\t"]'):
            self.assertEqual(self.code(text), "INVALID_JSON", text)

    def test_strings(self):
        self.assertEqual(self.parse('"\\ud83d\\ude00"'), "\U0001f600")
        self.assertEqual(self.code('"\\ud83d"'), "LONE_SURROGATE")
        self.assertEqual(self.code('"\\ude00"'), "LONE_SURROGATE")
        self.assertEqual(self.code('{"\\udc00":1}'), "LONE_SURROGATE")

    def test_booleans_are_not_integers(self):
        self.assertFalse(v.is_int(True))
        self.assertTrue(v.is_int(1))

    def test_depth_limit(self):
        self.assertEqual(self.code("[" * 33 + "]" * 33), "NESTING_TOO_DEEP")
        self.parse("[" * 32 + "]" * 32)

    def test_jcs_escapes(self):
        self.assertEqual(v.jcs("a\u0001\b\t\n\f\r\"\\\u007f z"), '"a\\u0001\\b\\t\\n\\f\\r\\"\\\\\u007f z"')


class Boundaries(unittest.TestCase):
    def imports(self):
        with open(os.path.join(HERE, "verify_vectors.py"), encoding="utf-8") as handle:
            tree = ast.parse(handle.read())
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                names.add(node.module.split(".")[0])
        return names

    def test_standard_library_only(self):
        self.assertTrue(self.imports() <= set(sys.stdlib_module_names), self.imports())

    def test_no_network_process_or_node_use(self):
        forbidden = {"socket", "ssl", "urllib", "http", "ftplib", "smtplib", "requests", "subprocess", "asyncio", "multiprocessing"}
        self.assertEqual(self.imports() & forbidden, set())
        with open(os.path.join(HERE, "verify_vectors.py"), encoding="utf-8") as handle:
            source = handle.read()
        self.assertNotIn("os.system", source)
        self.assertNotIn("popen", source.lower())


if __name__ == "__main__":
    unittest.main()
