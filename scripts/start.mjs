import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (Number(process.versions.node.split(".")[0]) < 24)
  throw new Error("Install Node.js 24 or newer before starting OpenAgents.");
const sdk = join(root, "software-agent-sdk");
const canvas = join(root, "canvas");
const state = resolve(
  process.env.OPENAGENTS_STATE_DIR ?? join(root, ".runtime"),
);
const python = join(
  sdk,
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
if (!existsSync(python) || !existsSync(join(canvas, "build/index.html")))
  throw new Error("Run npm run setup before starting OpenAgents.");
function port(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535)
    throw new Error("Ports must be integers from 1 to 65535.");
  return String(number);
}
const defaults = JSON.parse(
  readFileSync(join(canvas, "config/defaults.json"), "utf8"),
);
const backendPort = port(
  process.env.OPENAGENTS_BACKEND_PORT,
  defaults.ports.agentServer,
);
const frontendPort = port(process.env.OPENAGENTS_PORT, defaults.ports.proxy);
if (backendPort === frontendPort)
  throw new Error("Choose different backend and frontend ports.");
for (const candidate of [backendPort, frontendPort]) {
  await new Promise((done, reject) => {
    const probe = createServer();
    probe.once("error", () =>
      reject(new Error(`Port ${candidate} is already in use.`)),
    );
    probe.listen(Number(candidate), "127.0.0.1", () => probe.close(done));
  });
}
mkdirSync(state, { recursive: true });
const keyFile = join(state, "session-key");
if (!existsSync(keyFile))
  writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
const key = readFileSync(keyFile, "utf8").trim();
if (!key) throw new Error("The stored session key is empty.");
const children = [];
let stopping = false;
function launch(command, args, cwd, env = process.env) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  children.push(child);
  child.once("error", (error) => {
    console.error(error.message);
    void stop(1);
  });
  child.once("exit", (code) => {
    if (!stopping) void stop(code ?? 1);
  });
  return child;
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || !child.pid) return;
      const closed = once(child, "close").catch(() => {});
      if (process.platform === "win32") {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/t", "/f"],
          { windowsHide: true, stdio: "ignore" },
        );
        await once(killer, "exit");
      } else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* Already stopped. */
        }
      }
      await closed;
    }),
  );
  process.exit(code);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
launch(
  python,
  [
    "-m",
    "examples.agent_foundation.serve",
    "--host",
    "127.0.0.1",
    "--port",
    backendPort,
    ...(process.env.OPENAGENTS_TOOL_MODULES
      ? ["--import-modules", process.env.OPENAGENTS_TOOL_MODULES]
      : []),
  ],
  sdk,
  {
    ...process.env,
    PYTHONUTF8: "1",
    OH_PERSISTENCE_DIR: state,
    OH_CONVERSATIONS_PATH: join(state, "conversations"),
    OH_WORKSPACE_PATH: join(state, "workspace"),
    OH_BASH_EVENTS_DIR: join(state, "bash-events"),
    OH_CONVERSATION_WORKTREE_ROOT: join(state, "worktrees"),
    OH_SESSION_API_KEYS_0: key,
    OH_SECRET_KEY: key,
    OH_ENABLE_VSCODE: "false",
    OH_PRELOAD_TOOLS: "false",
    DO_NOT_TRACK: "1",
  },
);
const deadline = Date.now() + 120_000;
while (!stopping) {
  try {
    const response = await fetch(`http://127.0.0.1:${backendPort}/ready`);
    if (response.ok) break;
  } catch {
    /* Await backend readiness. */
  }
  if (Date.now() > deadline) {
    console.error("Agent Server did not become ready.");
    await stop(1);
  }
  await new Promise((done) => setTimeout(done, 200));
}
const target = `http://127.0.0.1:${backendPort}`;
launch(
  process.execPath,
  [
    "scripts/static-server.mjs",
    "--port",
    frontendPort,
    "--host",
    "127.0.0.1",
    "--dir",
    "build",
    "--session-api-key",
    key,
    "--disable-telemetry",
    ...[
      "/api",
      "/sockets",
      "/server_info",
      "/alive",
      "/health",
      "/ready",
      "/docs",
      "/redoc",
      "/openapi.json",
    ].flatMap((prefix) => ["--route", `${prefix}=${target}`]),
  ],
  canvas,
);
console.log(`OpenAgents: http://127.0.0.1:${frontendPort}`);
console.log(`Persistent state: ${state}`);
