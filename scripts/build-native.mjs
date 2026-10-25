import { execFileSync } from "node:child_process";
import { copyFile, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = [
  ...(process.env.CARGO_ENCODED_RUSTFLAGS || "").split("\x1f").filter(Boolean),
  "--remap-path-prefix=" + os.homedir() + "=/build",
];
execFileSync("cargo", ["build", "--manifest-path", path.join(root, "native/Cargo.toml"), "--release", "--locked", "--jobs", "2"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") },
});
await copyFile(path.join(root, "native/target/release/deck-craft-audio"), path.join(root, "native/deck-craft-audio"));
await chmod(path.join(root, "native/deck-craft-audio"), 0o755);
console.log("Built native streaming audio engine; compiler home paths remapped.");
