import test from "node:test";
import assert from "node:assert/strict";
import { releaseId } from "../scripts/package-identity.mjs";
test("release identity binds runtime, installer and source provenance, not only app files", () => {
  const base = {
    schema: 1,
    version: "0.2.0",
    platform: "linux-x64",
    sourceCommit: null,
    developmentSnapshot: true,
    installerSha256: "a".repeat(64),
    runtime: { version: "45.0.0", sha256: "b".repeat(64) },
    files: { "native/deck-craft-audio": { sha256: "c".repeat(64), mode: 493 } },
  };
  assert.equal(releaseId(base), releaseId(structuredClone(base)));
  for (const changed of [
    { sourceCommit: "d".repeat(40), developmentSnapshot: false },
    { runtime: { version: "45.0.1", sha256: "e".repeat(64) } },
    { installerSha256: "f".repeat(64) },
  ])
    assert.notEqual(releaseId({ ...base, ...changed }), releaseId(base));
});
