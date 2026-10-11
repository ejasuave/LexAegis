#!/usr/bin/env python3
"""Independent offline checker for the Proof of Review protocol v1 test vectors.

Standard library only. It does not run Node, import the TypeScript implementation, call a service
or use an expected output as a computed value. Every digest, commitment, canonical byte sequence
and status below is recomputed here, then compared with (a) the frozen expectation in the published
vectors and (b) optionally the outcomes the TypeScript implementation printed.

Constants (domains, limits, patterns, roles) are read from docs/SPEC.md, so this program is an
implementation of the specification rather than a transcription of the TypeScript code.

SUPPORTED JSON SUBSET (the protocol's constrained subset, NOT general RFC 8785):
  null, booleans, valid Unicode strings, arrays, objects with unique string keys, and plain integer
  tokens that are safe integers. Rejected: fractions and exponents, non-finite values, unsafe
  integers, lexical negative zero, lone surrogates, comments, trailing commas or content, a
  byte-order mark, malformed UTF-8, forbidden member names and nesting beyond 32 containers.
  Financial and protocol decimals stay strings. Object members are ordered by UTF-16 code unit.

It claims no registry, signature or live-chain verification and makes no network call.

Usage:
  python3 -I verify_vectors.py [--vectors FILE] [--spec FILE] [--ts-outcomes FILE] [--table|--json]
Exit status: 0 when every case agrees, 1 on any disagreement, 2 on unusable input.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
DEFAULT_VECTORS = os.path.join(REPO, "packages", "protocol", "test-vectors", "protocol-v1.json")
DEFAULT_SPEC = os.path.join(REPO, "docs", "SPEC.md")

SAFE_MAX = 2**53 - 1
FORBIDDEN_KEYS = ("__proto__", "constructor", "prototype")


class Reject(Exception):
    """A protocol rejection carrying only a stable code (never payload content)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


# ---- Constants read from SPEC.md ------------------------------------------------------------------


class Spec:
    """Constants parsed from the tagged literals, patterns, lists and tables of docs/SPEC.md."""

    def __init__(self, text: str) -> None:
        self.literals: Dict[str, str] = {}
        self.patterns: Dict[str, str] = {}
        self.lists: Dict[str, List[str]] = {}
        self.tables: Dict[str, Dict[str, str]] = {}
        lines = text.split("\n")
        for index, line in enumerate(lines):
            for match in re.finditer(r"<!--\s*spec:(\w+)\s+([A-Za-z0-9_.-]+)\s*-->", line):
                kind, name = match.group(1), match.group(2)
                if kind in ("literal", "pattern"):
                    spans = re.findall(r"`([^`]+)`", line[: match.start()])
                    if not spans:
                        raise ValueError("no value before tag " + name)
                    value = spans[-1].replace("\\|", "|")
                    (self.literals if kind == "literal" else self.patterns)[name] = value
                elif kind == "list":
                    self.lists[name] = self._list(lines, index + 1)
                elif kind == "table":
                    self.tables[name] = self._table(lines, index + 1)

    @staticmethod
    def _list(lines: List[str], start: int) -> List[str]:
        index = start
        while index < len(lines) and lines[index].strip() == "":
            index += 1
        items: List[str] = []
        while index < len(lines) and re.match(r"\s*-\s", lines[index]):
            spans = re.findall(r"`([^`]+)`", lines[index])
            items.append(spans[0] if spans else "")
            index += 1
        return items

    @staticmethod
    def _table(lines: List[str], start: int) -> Dict[str, str]:
        index = start
        while index < len(lines) and lines[index].strip() == "":
            index += 1
        rows: List[List[str]] = []
        while index < len(lines) and lines[index].strip().startswith("|"):
            cells = [cell.strip() for cell in re.split(r"(?<!\\)\|", lines[index].strip())[1:-1]]
            rows.append(cells)
            index += 1
        result: Dict[str, str] = {}
        for cells in rows[2:]:
            key = re.findall(r"`([^`]+)`", cells[0])
            value = re.findall(r"`([^`]+)`", cells[1])
            if key and value:
                result[key[0]] = value[0]
        return result

    def limit(self, name: str) -> int:
        return int(self.tables["LIMITS"][name])


# ---- Strict JSON subset -----------------------------------------------------------------------------

WHITESPACE = " \t\n\r"
INTEGER = re.compile(r"-?(?:0|[1-9][0-9]*)\Z")
NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}


def has_lone_surrogate(text: str) -> bool:
    return any(0xD800 <= ord(ch) <= 0xDFFF for ch in text)


class Parser:
    def __init__(self, text: str, max_depth: int, ordered_unique: bool = True) -> None:
        self.text = text
        self.pos = 0
        self.max_depth = max_depth
        self.ordered_unique = ordered_unique
        self.depth = 0

    def fail(self, code: str = "INVALID_JSON") -> "Reject":
        return Reject(code)

    def skip(self) -> None:
        while self.pos < len(self.text) and self.text[self.pos] in WHITESPACE:
            self.pos += 1

    def parse(self) -> Any:
        self.skip()
        value = self.value()
        self.skip()
        if self.pos != len(self.text):
            raise self.fail()
        return value

    def value(self) -> Any:
        if self.pos >= len(self.text):
            raise self.fail()
        ch = self.text[self.pos]
        if ch == "{":
            return self.obj()
        if ch == "[":
            return self.arr()
        if ch == '"':
            return self.string()
        for word, result in (("true", True), ("false", False), ("null", None)):
            if self.text.startswith(word, self.pos):
                self.pos += len(word)
                return result
        return self.number()

    def number(self) -> int:
        match = NUMBER.match(self.text, self.pos)
        if match is None:
            raise self.fail()
        token = match.group(0)
        self.pos = match.end()
        # A number token must end at a delimiter, otherwise the grammar is broken (for example "01").
        if self.pos < len(self.text) and self.text[self.pos] not in WHITESPACE + ",]}":
            raise self.fail()
        if INTEGER.match(token) is None or token == "-0":
            raise self.fail("UNSAFE_NUMBER")
        number = int(token)
        if abs(number) > SAFE_MAX:
            raise self.fail("UNSAFE_NUMBER")
        return number

    def string(self) -> str:
        self.pos += 1  # opening quote
        out: List[str] = []
        while True:
            if self.pos >= len(self.text):
                raise self.fail()
            ch = self.text[self.pos]
            if ch == '"':
                self.pos += 1
                break
            if ord(ch) < 0x20:
                raise self.fail()
            if ch != "\\":
                out.append(ch)
                self.pos += 1
                continue
            self.pos += 1
            if self.pos >= len(self.text):
                raise self.fail()
            esc = self.text[self.pos]
            if esc == "u":
                unit = self.text[self.pos + 1 : self.pos + 5]
                if len(unit) != 4 or re.fullmatch(r"[0-9a-fA-F]{4}", unit) is None:
                    raise self.fail()
                self.pos += 5
                code = int(unit, 16)
                if 0xD800 <= code <= 0xDBFF:
                    # A high surrogate must be followed by an escaped low surrogate.
                    tail = self.text[self.pos : self.pos + 6]
                    low = int(tail[2:], 16) if re.fullmatch(r"\\u[dD][c-fC-F][0-9a-fA-F]{2}", tail) else None
                    if low is None:
                        raise self.fail("LONE_SURROGATE")
                    self.pos += 6
                    out.append(chr(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)))
                elif 0xDC00 <= code <= 0xDFFF:
                    raise self.fail("LONE_SURROGATE")
                else:
                    out.append(chr(code))
            elif esc in ESCAPES:
                out.append(ESCAPES[esc])
                self.pos += 1
            else:
                raise self.fail()
        text = "".join(out)
        if has_lone_surrogate(text):
            raise self.fail("LONE_SURROGATE")
        return text

    def open_container(self) -> None:
        # Checked before descending: the 33rd nested container is the first one refused.
        if self.depth >= self.max_depth:
            raise self.fail("NESTING_TOO_DEEP")
        self.depth += 1

    def arr(self) -> List[Any]:
        self.open_container()
        self.pos += 1
        items: List[Any] = []
        self.skip()
        if self.text[self.pos : self.pos + 1] == "]":
            self.pos += 1
            self.depth -= 1
            return items
        while True:
            self.skip()
            items.append(self.value())
            self.skip()
            ch = self.text[self.pos : self.pos + 1]
            self.pos += 1
            if ch == "]":
                break
            if ch != ",":
                raise self.fail()
        self.depth -= 1
        return items

    def obj(self) -> Dict[str, Any]:
        self.open_container()
        self.pos += 1
        members: Dict[str, Any] = {}
        self.skip()
        if self.text[self.pos : self.pos + 1] == "}":
            self.pos += 1
            self.depth -= 1
            return members
        while True:
            self.skip()
            if self.text[self.pos : self.pos + 1] != '"':
                raise self.fail()
            key = self.string()  # decoded, so names equal only after escape decoding collide
            if key in FORBIDDEN_KEYS:
                raise self.fail("FORBIDDEN_KEY")
            if key in members and self.ordered_unique:
                raise self.fail("DUPLICATE_KEY")
            self.skip()
            if self.text[self.pos : self.pos + 1] != ":":
                raise self.fail()
            self.pos += 1
            self.skip()
            members[key] = self.value()
            self.skip()
            ch = self.text[self.pos : self.pos + 1]
            self.pos += 1
            if ch == "}":
                break
            if ch != ",":
                raise self.fail()
        self.depth -= 1
        return members


def parse_strict(data: bytes, spec: Spec, reject_duplicates: bool = True) -> Any:
    if len(data) > spec.limit("maxJsonBytes"):
        raise Reject("INPUT_TOO_LARGE")
    if data[:3] == b"\xef\xbb\xbf":
        raise Reject("BYTE_ORDER_MARK")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise Reject("INVALID_UTF8") from None
    return Parser(text, spec.limit("maxDepth"), reject_duplicates).parse()


# ---- RFC 8785 for the supported subset ----------------------------------------------------------------


def utf16_key(name: str) -> bytes:
    """Big-endian UTF-16 code units: byte order equals code-unit order (code points would be wrong)."""
    return name.encode("utf-16-be")


def jcs_string(value: str) -> str:
    out = ['"']
    for ch in value:
        code = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\r":
            out.append("\\r")
        elif code < 0x20:
            out.append("\\u%04x" % code)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def jcs(value: Any, key_order: str = "utf16") -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return jcs_string(value)
    if isinstance(value, list):
        return "[" + ",".join(jcs(item, key_order) for item in value) + "]"
    if isinstance(value, dict):
        # `codepoint` exists only so tests can prove a code-point ordering mistake is detected.
        key = utf16_key if key_order == "utf16" else (lambda name: name.encode("utf-32-be"))
        names = sorted(value.keys(), key=key)
        return "{" + ",".join(jcs_string(name) + ":" + jcs(value[name], key_order) for name in names) + "}"
    raise Reject("UNSUPPORTED_VALUE")


# ---- Closed v1 schemas -----------------------------------------------------------------------------------


def is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)  # bool is not an integer here


def days_in_month(year: int, month: int) -> int:
    if month == 2:
        return 29 if (year % 4 == 0 and year % 100 != 0) or year % 400 == 0 else 28
    return 30 if month in (4, 6, 9, 11) else 31


def valid_timestamp(value: str) -> bool:
    match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z", value)
    if match is None:
        return False
    year, month, day, hour, minute, second = (int(part) for part in match.groups())
    return 1 <= month <= 12 and 1 <= day <= days_in_month(year, month) and hour <= 23 and minute <= 59 and second <= 59


class Schemas:
    def __init__(self, spec: Spec) -> None:
        self.spec = spec
        self.p = {name: re.compile(pattern) for name, pattern in spec.patterns.items()}
        self.roles = tuple(spec.lists["ARTIFACT_ROLES"])
        self.zero_address = "0x" + "00" * 20
        self.max_artifacts = spec.limit("maxArtifacts")
        self.max_artifact_bytes = spec.limit("maxArtifactBytes")
        self.max_total = spec.limit("maxTotalArtifactBytes")
        self.max_label = spec.limit("maxLabelCodePoints")
        self.max_media = spec.limit("maxMediaTypeLength")

    def match(self, name: str, value: Any) -> bool:
        return isinstance(value, str) and self.p[name].fullmatch(value) is not None

    # Each validator raises Reject on the first violated rule, in the order the specification gives.

    def closed(self, value: Any, names: Tuple[str, ...]) -> Dict[str, Any]:
        if not isinstance(value, dict):
            raise Reject("SCHEMA_INVALID")
        for name in names:
            if name not in value:
                raise Reject("SCHEMA_INVALID")
        return value

    def unknown_check(self, value: Dict[str, Any], names: Tuple[str, ...]) -> None:
        if any(key not in names for key in value):
            raise Reject("UNKNOWN_FIELD")

    def nonzero_address(self, value: Any) -> None:
        if not self.match("address", value) or value == self.zero_address:
            raise Reject("SCHEMA_INVALID")

    def chain_id(self, value: Any) -> None:
        if not self.match("chainId", value) or len(value) > 78 or int(value) > 2**256 - 1:
            raise Reject("SCHEMA_INVALID")

    def reference(self, value: Any) -> Dict[str, Any]:
        names = ("schema", "chainId", "registryAddress", "reviewerAddress", "commitment")
        ref = self.closed(value, names)
        self.unknown_check(ref, names)
        if ref["schema"] != self.spec.literals["REFERENCE_SCHEMA"]:
            raise Reject("SCHEMA_INVALID")
        self.chain_id(ref["chainId"])
        self.nonzero_address(ref["registryAddress"])
        self.nonzero_address(ref["reviewerAddress"])
        if not self.match("digest", ref["commitment"]):
            raise Reject("SCHEMA_INVALID")
        return ref

    def artifact(self, value: Any) -> Dict[str, Any]:
        names = ("id", "role", "mediaType", "label", "byteLength", "sha256")
        item = self.closed(value, names)
        self.unknown_check(item, names)
        if not self.match("uuid", item["id"]) or item["role"] not in self.roles:
            raise Reject("SCHEMA_INVALID")
        media = item["mediaType"]
        if not self.match("mediaType", media) or len(media) > self.max_media:
            raise Reject("SCHEMA_INVALID")
        label = item["label"]
        if label is not None and (not isinstance(label, str) or len(label) > self.max_label):
            raise Reject("SCHEMA_INVALID")
        length = item["byteLength"]
        if not self.match("unsignedDecimal", length):
            raise Reject("SCHEMA_INVALID")
        if int(length) > self.max_artifact_bytes:
            raise Reject("ARTIFACT_TOO_LARGE")
        if not self.match("digest", item["sha256"]):
            raise Reject("SCHEMA_INVALID")
        return item

    def manifest(self, value: Any) -> Dict[str, Any]:
        names = ("schema", "packageId", "preparedAt", "profile", "context", "supersedes", "artifacts", "approval")
        man = self.closed(value, names)
        self.unknown_check(man, names)
        if man["schema"] != self.spec.literals["PACKAGE_SCHEMA"]:
            raise Reject("SCHEMA_INVALID")
        if not self.match("uuid", man["packageId"]):
            raise Reject("SCHEMA_INVALID")
        if not isinstance(man["preparedAt"], str) or not valid_timestamp(man["preparedAt"]):
            raise Reject("SCHEMA_INVALID")
        profile = self.closed(man["profile"], ("id", "version"))
        self.unknown_check(profile, ("id", "version"))
        if not self.match("profileId", profile["id"]) or not self.match("profileVersion", profile["version"]):
            raise Reject("SCHEMA_INVALID")
        context = self.closed(man["context"], ("chainId", "registryAddress", "reviewerAddress"))
        self.unknown_check(context, ("chainId", "registryAddress", "reviewerAddress"))
        self.chain_id(context["chainId"])
        self.nonzero_address(context["registryAddress"])
        self.nonzero_address(context["reviewerAddress"])
        if man["supersedes"] is not None:
            self.reference(man["supersedes"])
        artifacts = man["artifacts"]
        if not isinstance(artifacts, list):
            raise Reject("SCHEMA_INVALID")
        if len(artifacts) > self.max_artifacts:
            raise Reject("TOO_MANY_ARTIFACTS")
        for artifact in artifacts:
            self.artifact(artifact)
        approval = self.closed(man["approval"], ("intent", "scopeArtifactIds", "decisionLogArtifactId"))
        self.unknown_check(approval, ("intent", "scopeArtifactIds", "decisionLogArtifactId"))
        scope = approval["scopeArtifactIds"]
        if (
            approval["intent"] != self.spec.literals["APPROVAL_INTENT"]
            or not isinstance(scope, list)
            or len(scope) > self.max_artifacts
            or not all(self.match("uuid", item) for item in scope)
            or not self.match("uuid", approval["decisionLogArtifactId"])
        ):
            raise Reject("SCHEMA_INVALID")
        self.cross_field(man)
        return man

    def cross_field(self, man: Dict[str, Any]) -> None:
        artifacts = man["artifacts"]
        roles: Dict[str, str] = {}
        for item in artifacts:
            if item["id"] in roles:
                raise Reject("DUPLICATE_ARTIFACT_ID")
            roles[item["id"]] = item["role"]
        if not any(item["role"] == "source" for item in artifacts):
            raise Reject("SOURCE_ARTIFACT_REQUIRED")
        if sum(1 for item in artifacts if item["role"] == "decision-log") != 1:
            raise Reject("DECISION_LOG_ARTIFACT_INVALID")
        approval = man["approval"]
        seen: set = set()
        for ident in approval["scopeArtifactIds"]:
            if ident in seen:
                raise Reject("DUPLICATE_SCOPE_ID")
            if ident not in roles:
                raise Reject("UNRESOLVED_ARTIFACT_REFERENCE")
            seen.add(ident)
        if len(seen) != len(roles):
            raise Reject("SCOPE_INCOMPLETE")
        log_role = roles.get(approval["decisionLogArtifactId"])
        if log_role is None:
            raise Reject("UNRESOLVED_ARTIFACT_REFERENCE")
        if log_role != "decision-log":
            raise Reject("DECISION_LOG_REFERENCE_INVALID")
        if sum(int(item["byteLength"]) for item in artifacts) > self.max_total:
            raise Reject("ARTIFACTS_TOO_LARGE")
        prior = man["supersedes"]
        context = man["context"]
        if prior is not None and (
            prior["chainId"] != context["chainId"]
            or prior["registryAddress"] != context["registryAddress"]
            or prior["reviewerAddress"] != context["reviewerAddress"]
        ):
            raise Reject("SUPERSEDES_CONTEXT_MISMATCH")

    def require_version(self, value: Any, expected: str) -> None:
        """Version dispatch: a non-object or a non-string schema is invalid; another version is unsupported."""
        schema = value.get("schema") if isinstance(value, dict) else None
        if not isinstance(schema, str):
            raise Reject("SCHEMA_INVALID")
        if schema != expected:
            raise Reject("UNSUPPORTED_VERSION")

    def read_reference(self, data: bytes, parse: Any) -> Dict[str, Any]:
        value = parse(data)
        self.require_version(value, self.spec.literals["REFERENCE_SCHEMA"])
        return self.reference(value)

    def read_opening(self, data: bytes, parse: Any) -> Dict[str, Any]:
        value = parse(data)
        self.require_version(value, self.spec.literals["OPENING_SCHEMA"])
        manifest = value.get("manifest") if isinstance(value, dict) else None
        if manifest is not None or (isinstance(value, dict) and "manifest" in value):
            self.require_version(manifest, self.spec.literals["PACKAGE_SCHEMA"])
            prior = manifest.get("supersedes") if isinstance(manifest, dict) else None
            if prior is not None:
                self.require_version(prior, self.spec.literals["REFERENCE_SCHEMA"])
        names = ("schema", "manifest", "blindingNonce")
        opening = self.closed(value, names)
        self.unknown_check(opening, names)
        self.manifest(opening["manifest"])
        if not self.match("blindingNonce", opening["blindingNonce"]):
            raise Reject("SCHEMA_INVALID")
        return opening


# ---- Hashing ------------------------------------------------------------------------------------------------------


def sha256(*parts: bytes) -> bytes:
    h = hashlib.sha256()
    for part in parts:
        h.update(part)
    return h.digest()


def hex0x(data: bytes) -> str:
    return "0x" + data.hex()


def from_hex(value: str, length: Optional[int] = None) -> bytes:
    if re.fullmatch(r"0x(?:[0-9a-f]{2})*", value) is None:
        raise Reject("INVALID_HEX")
    data = bytes.fromhex(value[2:])
    if length is not None and len(data) != length:
        raise Reject("INVALID_BYTE_LENGTH")  # rejected before any concatenation
    return data


class Engine:
    """The independent implementation. `Options` exist only so tests can prove mistakes are caught."""

    def __init__(self, spec: Spec, key_order: str = "utf16", reject_duplicates: bool = True) -> None:
        self.spec = spec
        self.schemas = Schemas(spec)
        self.key_order = key_order
        self.reject_duplicates = reject_duplicates
        self.package_domain = spec.literals["PACKAGE_DOMAIN"].encode("utf-8")
        self.commitment_domain = spec.literals["COMMITMENT_DOMAIN"].encode("utf-8")

    def parse(self, data: bytes) -> Any:
        return parse_strict(data, self.spec, self.reject_duplicates)

    def canonical_manifest(self, manifest: Dict[str, Any]) -> bytes:
        return jcs(manifest, self.key_order).encode("utf-8")

    def package_digest(self, canonical: bytes) -> bytes:
        return sha256(self.package_domain, b"\x00", canonical)

    def commitment(self, nonce: bytes, digest: bytes) -> bytes:
        if len(nonce) != 32 or len(digest) != 32:
            raise Reject("INVALID_BYTE_LENGTH")
        return sha256(self.commitment_domain, b"\x00", nonce, digest)

    def opening_commitment(self, opening: Dict[str, Any]) -> str:
        digest = self.package_digest(self.canonical_manifest(opening["manifest"]))
        return hex0x(self.commitment(from_hex(opening["blindingNonce"], 32), digest))

    def verify_package(
        self, opening_bytes: bytes, supplied: List[Tuple[str, bytes]], reference_bytes: bytes
    ) -> Dict[str, Any]:
        expected = self.schemas.read_reference(reference_bytes, self.parse)
        opening = self.schemas.read_opening(opening_bytes, self.parse)
        manifest = opening["manifest"]
        declared = {item["id"]: item for item in manifest["artifacts"]}
        seen: set = set()
        captured: Dict[str, bytes] = {}
        length_mismatch: List[str] = []
        extra: List[str] = []
        for ident, data in supplied:
            if ident in seen:
                raise Reject("ARTIFACT_DUPLICATE")
            seen.add(ident)
            item = declared.get(ident)
            if item is None:
                extra.append(ident)
            elif len(data) != int(item["byteLength"]):
                length_mismatch.append(ident)
            else:
                captured[ident] = data
        missing = [item["id"] for item in manifest["artifacts"] if item["id"] not in seen]

        issues: List[Dict[str, str]] = []
        context = manifest["context"]
        if (
            context["chainId"] != expected["chainId"]
            or context["registryAddress"] != expected["registryAddress"]
            or context["reviewerAddress"] != expected["reviewerAddress"]
        ):
            issues.append({"code": "CONTEXT_MISMATCH"})
        if self.opening_commitment(opening) != expected["commitment"]:
            issues.append({"code": "COMMITMENT_MISMATCH"})
        if issues:
            issues.append({"code": "ARTIFACTS_NOT_EVALUATED"})
            return {"outcome": "ok", "manifestIntegrity": "mismatch", "artifactIntegrity": "unknown", "issues": issues}

        mismatch = False
        for ident in extra:
            mismatch = True
            issues.append({"code": "ARTIFACT_NOT_IN_MANIFEST", "artifactId": ident})
        for ident in length_mismatch:
            mismatch = True
            issues.append({"code": "ARTIFACT_LENGTH_MISMATCH", "artifactId": ident})
        for item in manifest["artifacts"]:
            data = captured.get(item["id"])
            if data is not None and hex0x(sha256(data)) != item["sha256"]:
                mismatch = True
                issues.append({"code": "ARTIFACT_DIGEST_MISMATCH", "artifactId": item["id"]})
        for ident in missing:
            issues.append({"code": "ARTIFACT_MISSING", "artifactId": ident})
        integrity = "mismatch" if mismatch else ("unknown" if missing else "match")
        return {"outcome": "ok", "manifestIntegrity": "match", "artifactIntegrity": integrity, "issues": issues}


# ---- Cases --------------------------------------------------------------------------------------------------------


def decode_input(item: Dict[str, str]) -> bytes:
    encoding, value = item["encoding"], item["value"]
    if encoding == "utf8":
        return value.encode("utf-8")
    if encoding == "hex":
        return from_hex(value)
    if encoding == "base64":
        return base64.b64decode(value, validate=True)
    raise ValueError("unknown encoding")


def run_case(engine: Engine, case: Dict[str, Any]) -> Dict[str, Any]:
    """What this implementation produces for one case. It never reads the case's `expected`."""
    operation, data = case["operation"], case["input"]
    try:
        if operation == "canonicalize-json":
            value = engine.parse(decode_input(data))
            return {"outcome": "ok", "canonicalUtf8Hex": hex0x(jcs(value, engine.key_order).encode("utf-8"))}
        if operation == "canonical-manifest":
            opening = engine.schemas.read_opening(decode_input(data), engine.parse)
            return {"outcome": "ok", "canonicalUtf8Hex": hex0x(engine.canonical_manifest(opening["manifest"]))}
        if operation == "artifact-digest":
            return {"outcome": "ok", "digest": hex0x(sha256(decode_input(data)))}
        if operation == "package-digest":
            return {"outcome": "ok", "digest": hex0x(engine.package_digest(decode_input(data)))}
        if operation == "commitment":
            nonce = from_hex(data["blindingNonce"], 32)
            digest = from_hex(data["packageDigest"], 32)
            return {"outcome": "ok", "commitment": hex0x(engine.commitment(nonce, digest))}
        if operation == "parse-opening":
            engine.schemas.read_opening(decode_input(data), engine.parse)
            return {"outcome": "ok"}
        if operation == "parse-reference":
            engine.schemas.read_reference(decode_input(data), engine.parse)
            return {"outcome": "ok"}
        if operation == "verify-package":
            supplied = [(item["id"], decode_input(item)) for item in data["artifacts"]]
            return engine.verify_package(
                decode_input(data["opening"]), supplied, decode_input(data["expectedReference"])
            )
    except Reject as rejection:
        return {"outcome": "error", "code": rejection.code}
    raise ValueError("unsupported operation: " + operation)


STAGES = {
    "INPUT_TOO_LARGE": ("strict-json",), "INVALID_UTF8": ("strict-json",), "BYTE_ORDER_MARK": ("strict-json",),
    "INVALID_JSON": ("strict-json",), "DUPLICATE_KEY": ("strict-json",), "NESTING_TOO_DEEP": ("strict-json",),
    "UNSAFE_NUMBER": ("strict-json",), "LONE_SURROGATE": ("strict-json",), "FORBIDDEN_KEY": ("strict-json",),
    "UNSUPPORTED_VERSION": ("version",), "SCHEMA_INVALID": ("version", "schema"),
    "UNKNOWN_FIELD": ("schema",), "TOO_MANY_ARTIFACTS": ("schema",), "ARTIFACT_TOO_LARGE": ("schema",),
    "DUPLICATE_ARTIFACT_ID": ("cross-field",), "SOURCE_ARTIFACT_REQUIRED": ("cross-field",),
    "DECISION_LOG_ARTIFACT_INVALID": ("cross-field",), "DUPLICATE_SCOPE_ID": ("cross-field",),
    "UNRESOLVED_ARTIFACT_REFERENCE": ("cross-field",), "SCOPE_INCOMPLETE": ("cross-field",),
    "DECISION_LOG_REFERENCE_INVALID": ("cross-field",), "SUPERSEDES_CONTEXT_MISMATCH": ("cross-field",),
    "ARTIFACTS_TOO_LARGE": ("cross-field",),
}


def compare(case: Dict[str, Any], actual: Dict[str, Any], ts: Optional[Dict[str, Any]]) -> List[str]:
    """Disagreements as short codes. Messages carry case ids and codes, never payload content."""
    problems: List[str] = []
    expected = {k: v for k, v in case["expected"].items() if k != "stage"}
    if actual != expected:
        problems.append("differs-from-frozen-expectation")
    if expected.get("outcome") == "error":
        stage = case["expected"].get("stage")
        # Rejecting at another stage than the case names is not a pass.
        if stage != case["stage"] or stage not in STAGES.get(actual.get("code", ""), ()):
            problems.append("wrong-stage")
    if ts is not None:
        if case["id"] not in ts:
            problems.append("missing-from-typescript-outcomes")
        elif ts[case["id"]] != actual:
            problems.append("differs-from-typescript")
    return problems


def summarize(case: Dict[str, Any], actual: Dict[str, Any]) -> str:
    if actual["outcome"] == "error":
        return "error " + actual["code"]
    if case["operation"] == "verify-package":
        codes = ",".join(issue["code"] for issue in actual["issues"]) or "-"
        return "manifest=%s artifacts=%s issues=%s" % (actual["manifestIntegrity"], actual["artifactIntegrity"], codes)
    return "ok"


def run_all(
    vectors: Dict[str, Any], engine: Engine, ts: Optional[Dict[str, Any]] = None
) -> List[Tuple[Dict[str, Any], Dict[str, Any], List[str]]]:
    results = []
    for case in vectors["cases"]:
        actual = run_case(engine, case)
        results.append((case, actual, compare(case, actual, ts)))
    return results


def check_goldens(vectors: Dict[str, Any], engine: Engine) -> List[str]:
    """The original Chapter 2 goldens, recomputed from their raw inputs."""
    problems: List[str] = []
    for golden in vectors["goldens"]:
        gid, expected = golden["id"], golden["expected"]
        manifest = engine.schemas.read_opening(json.dumps(golden["opening"]).encode("utf-8"), engine.parse)["manifest"]
        canonical = engine.canonical_manifest(manifest)
        if hex0x(canonical) != expected["canonicalManifestUtf8Hex"]:
            problems.append(gid + ": canonical bytes")
        digest = engine.package_digest(canonical)
        if hex0x(digest) != expected["packageDigest"]:
            problems.append(gid + ": package digest")
        nonce = from_hex(golden["opening"]["blindingNonce"], 32)
        if hex0x(engine.commitment(nonce, digest)) != expected["commitment"]:
            problems.append(gid + ": commitment")
        for item in golden["artifacts"]:
            raw = base64.b64decode(item["bytesBase64"], validate=True)
            if hex0x(sha256(raw)) != expected["artifactDigests"][item["id"]]:
                problems.append(gid + ": artifact digest")
    return problems


def load_json(path: str) -> Any:
    with open(path, "rb") as handle:
        return json.loads(handle.read().decode("utf-8"))


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--vectors", default=DEFAULT_VECTORS)
    parser.add_argument("--spec", default=DEFAULT_SPEC)
    parser.add_argument("--ts-outcomes", default=None, help="JSON written by `pnpm vectors:ts-outcomes`")
    parser.add_argument("--table", action="store_true", help="print every case")
    parser.add_argument("--json", action="store_true", help="print a JSON array instead of a table")
    args = parser.parse_args(argv)
    try:
        with open(args.spec, encoding="utf-8") as handle:
            spec = Spec(handle.read())
        vectors = load_json(args.vectors)
        ts = load_json(args.ts_outcomes) if args.ts_outcomes else None
    except (OSError, ValueError, KeyError) as error:
        print("unusable input: " + type(error).__name__, file=sys.stderr)
        return 2

    problems: List[str] = []
    domains = vectors.get("domains", {})
    if domains.get("package") != spec.literals["PACKAGE_DOMAIN"] or domains.get("commitment") != spec.literals["COMMITMENT_DOMAIN"]:
        problems.append("domains: the vectors and SPEC.md disagree")
    engine = Engine(spec)
    problems += check_goldens(vectors, engine)
    results = run_all(vectors, engine, ts)

    rows = []
    failed = 0
    for case, actual, case_problems in results:
        failed += 1 if case_problems else 0
        rows.append({"id": case["id"], "operation": case["operation"], "result": summarize(case, actual), "problems": case_problems})
    if args.json:
        print(json.dumps(rows, indent=1))
    else:
        for row in rows:
            if args.table or row["problems"]:
                flag = "FAIL" if row["problems"] else "ok  "
                print("%s %-52s %-18s %s %s" % (flag, row["id"], row["operation"], row["result"], ",".join(row["problems"])))
    for problem in problems:
        print("FAIL golden " + problem)
    print(
        "cases=%d passed=%d failed=%d goldens=%d typescript=%s"
        % (len(rows), len(rows) - failed, failed, len(vectors["goldens"]), "compared" if ts is not None else "not-compared")
    )
    return 0 if failed == 0 and not problems else 1


if __name__ == "__main__":
    sys.exit(main())
