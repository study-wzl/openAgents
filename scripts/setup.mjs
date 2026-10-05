import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (Number(process.versions.node.split(".")[0]) < 24)
  throw new Error("Install Node.js 24 or newer before setup.");
const sdk = resolve(root, "software-agent-sdk");
const canvas = resolve(root, "canvas");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32" && command === npm,
    env: { ...process.env, OH_AGENT_SERVER_LOCAL_PATH: sdk },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("uv", ["sync", "--frozen", "--group", "dev"], sdk);
run(npm, ["ci"], resolve(sdk, "clients/typescript"));
run(npm, ["ci"], canvas);
run(npm, ["run", "sdk:local"], canvas);
run(npm, ["run", "build"], canvas);
console.log(
  "Setup complete. Run npm start, then configure the business LLM profile.",
);
