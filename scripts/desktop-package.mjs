import { readFile, writeFile, mkdir, copyFile, cp, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { releaseId } from "./package-identity.mjs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (process.platform !== "linux" || process.arch !== "x64") throw Error("This packager targets Linux x86-64.");
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
if (dirty && !process.argv.includes("--allow-dirty"))
  throw Error("Commit and review source before publishing a package. --allow-dirty is for local development packages only.");
const native = path.join(root, "native/target/release/deck-craft-audio");
execFileSync(process.execPath, [path.join(root, "scripts/build.mjs")], { cwd: root, stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts/build-native.mjs")], { cwd: root, stdio: "inherit" });
await stat(native);
const version = pkg.devDependencies.electron;
const runtimeFile = `electron-v${version}-linux-x64.zip`;
const checksumResponse = await fetch(`https://github.com/electron/electron/releases/download/v${version}/SHASUMS256.txt`);
if (!checksumResponse.ok) throw Error("Official runtime checksums unavailable");
const line = (await checksumResponse.text()).split("\n").find((l) => l.trim().split(/\s+/).at(-1).replace(/^\*/, "") === runtimeFile);
const runtimeSha = line?.trim().split(/\s+/)[0];
if (!/^[0-9a-f]{64}$/.test(runtimeSha)) throw Error("Official runtime checksum missing");
const sourceCommit = dirty ? null : execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const releaseRoot = path.join(root, "release");
await mkdir(releaseRoot, { recursive: true });
const folder = path.join(releaseRoot, `deck-craft-${pkg.version}-linux-x64`);
await rm(folder, { recursive: true, force: true });
await mkdir(path.join(folder, "app"), { recursive: true });
const app = path.join(folder, "app");
for (const file of [
  "desktop/main.cjs",
  "desktop/preload.cjs",
  "desktop/audio-client.cjs",
  "desktop/library.cjs",
  "desktop/policy.cjs",
  "assets/deck-craft.svg",
]) {
  const destination = path.join(app, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(root, file), destination);
}
await mkdir(path.join(app, "dist"));
await copyFile(path.join(root, "dist/deck-craft.html"), path.join(app, "dist/deck-craft.html"));
await mkdir(path.join(app, "native"));
await copyFile(native, path.join(app, "native/deck-craft-audio"));
await copyFile(path.join(root, "LICENSE"), path.join(app, "LICENSE"));
await writeFile(
  path.join(app, "package.json"),
  JSON.stringify(
    { name: "deck-craft", productName: "Deck Craft", version: pkg.version, main: "desktop/main.cjs", license: "MIT" },
    null,
    2,
  ),
);
await copyFile(path.join(root, "scripts/install-desktop.py"), path.join(folder, "install.py"));
// Include the licenses of the Rust libraries statically linked into the engine.
const cargo = JSON.parse(
  execFileSync("cargo", ["metadata", "--manifest-path", path.join(root, "native/Cargo.toml"), "--locked", "--format-version", "1"], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  }),
);
const notices = [];
for (const dependency of cargo.packages.filter((p) => p.source)) {
  const crateRoot = path.dirname(dependency.manifest_path),
    out = path.join(app, "third-party", dependency.name + "-" + dependency.version);
  await mkdir(out, { recursive: true });
  notices.push({
    name: dependency.name,
    version: dependency.version,
    license: dependency.license,
    repository: dependency.repository,
    sourceArchive: `https://crates.io/api/v1/crates/${dependency.name}/${dependency.version}/download`,
  });
  const names = (await readdir(crateRoot)).filter((n) => /^(license|copying|notice)/i.test(n));
  for (const name of names) {
    const source = path.join(crateRoot, name);
    if ((await stat(source)).isFile()) await copyFile(source, path.join(out, name));
  }
  if (dependency.license_file) {
    const file = path.resolve(crateRoot, dependency.license_file);
    if (file.startsWith(crateRoot + path.sep)) await copyFile(file, path.join(out, "LICENSE.package"));
  }
}
const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
const stdNotice = path.join(sysroot, "share/doc/rust/COPYRIGHT-library.html");
await mkdir(path.join(app, "third-party/rust-standard-library"), { recursive: true });
await copyFile(stdNotice, path.join(app, "third-party/rust-standard-library/COPYRIGHT.html"));
await writeFile(
  path.join(app, "THIRD-PARTY.json"),
  JSON.stringify(
    {
      electron: { version, license: "MIT", runtimeNotices: "The verified official runtime retains LICENSE and LICENSES.chromium.html." },
      rust: notices,
    },
    null,
    2,
  ),
);
const hashFile = async (p) =>
  createHash("sha256")
    .update(await readFile(p))
    .digest("hex");
const files = {};
async function inventory(directory, prefix = "") {
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name),
      relative = prefix + name,
      s = await stat(file);
    if (s.isDirectory()) await inventory(file, relative + "/");
    else files[relative] = { sha256: await hashFile(file), mode: relative === "native/deck-craft-audio" ? 0o755 : 0o644 };
  }
}
await inventory(app);
const manifest = {
  schema: 1,
  version: pkg.version,
  platform: "linux-x64",
  sourceCommit,
  developmentSnapshot: !!dirty,
  installerSha256: await hashFile(path.join(folder, "install.py")),
  runtime: { version, url: `https://github.com/electron/electron/releases/download/v${version}/${runtimeFile}`, sha256: runtimeSha },
  files,
};
const release = releaseId(manifest);
manifest.release = release;
await writeFile(path.join(folder, "manifest.json"), JSON.stringify(manifest, null, 2));
await writeFile(
  path.join(folder, "README.txt"),
  "Deck Craft native Linux preview\n\nRun: python3 install.py\nThe installer verifies the payload, downloads and verifies the pinned official Electron runtime, and installs only under your home directory. No sudo is used. An offline runtime ZIP can be provided with --runtime-zip.\n\nLaunch Deck Craft from the application menu. Import your own audio; demo rows contain no audio. Restored decks remain paused.\n\nRollback: python3 ~/.local/share/deck-craft/installer.py --rollback\n\nPhysical Omarchy/laptop acceptance and hardware latency are not yet verified. This is an early native playback foundation, not a Serato/Traktor replacement yet.\n",
);
const archive = folder + ".tar.gz";
execFileSync("tar", ["-czf", archive, "-C", releaseRoot, path.basename(folder)]);
const sha = await hashFile(archive);
await writeFile(archive + ".sha256", sha + "  " + path.basename(archive) + "\n");
console.log(
  JSON.stringify({ archive, sha256: sha, bytes: (await stat(archive)).size, release, sourceCommit, developmentSnapshot: !!dirty }, null, 2),
);
