// Development bridge only: release Agent Server and its client before publishing Canvas.
import { cp, readFile, access } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";

const source = process.env.OH_AGENT_SERVER_LOCAL_PATH;
if (!source || !isAbsolute(source)) {
  throw new Error(
    "Set OH_AGENT_SERVER_LOCAL_PATH to your software-agent-sdk checkout.",
  );
}
const client = resolve(source, "clients/typescript");
await access(resolve(client, "package.json"));
const executable = process.platform === "win32" ? "npm.cmd" : "npm";
const build = spawnSync(executable, ["run", "build"], {
  cwd: client,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (build.status !== 0) process.exit(build.status ?? 1);
const manifest = JSON.parse(
  await readFile(resolve(client, "package.json"), "utf8"),
);
const installed = resolve("node_modules/@openhands/typescript-client");
await access(resolve(installed, "package.json"));
await cp(resolve(client, "dist"), resolve(installed, "dist"), {
  recursive: true,
});
await cp(resolve(client, "src"), resolve(installed, "src"), {
  recursive: true,
});
console.log(
  `Prepared local SDK client ${manifest.version}. npm ci restores the released client.`,
);
