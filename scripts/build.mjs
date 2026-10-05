import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canvas = resolve(root, "canvas");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
for (const script of ["sdk:local", "build", "build:lib"]) {
  const result = spawnSync(npm, ["run", script], {
    cwd: canvas,
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32",
    env: {
      ...process.env,
      OH_AGENT_SERVER_LOCAL_PATH: resolve(root, "software-agent-sdk"),
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
