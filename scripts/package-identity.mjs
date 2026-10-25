import { createHash } from "node:crypto";
export function releaseId(manifest) {
  return manifest.version + "-" + createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 12);
}
