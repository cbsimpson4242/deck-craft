import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
execFileSync("python3", [fileURLToPath(new URL("./desktop-test.py", import.meta.url))], { stdio: "inherit", env: process.env });
