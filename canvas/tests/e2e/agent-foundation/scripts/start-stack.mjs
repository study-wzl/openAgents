import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const sdk = resolve(
  process.env.FOUNDATION_E2E_SDK_DIR ?? join(root, "../software-agent-sdk"),
);
const python =
  process.env.FOUNDATION_E2E_PYTHON ??
  join(
    sdk,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
if (!existsSync(python))
  throw new Error("Prepare the SDK .venv or set FOUNDATION_E2E_PYTHON.");
if (!process.env.FOUNDATION_E2E_SESSION_API_KEY)
  throw new Error("Launch through playwright.foundation.config.ts.");

const backendPort = process.env.FOUNDATION_E2E_BACKEND_PORT ?? "19300";
const frontendPort = process.env.FOUNDATION_E2E_FRONTEND_PORT ?? "19301";
const state = mkdtempSync(join(tmpdir(), "openhands-foundation-e2e-"));
const children = [];
let stopping = false;

function launch(command, args, options = {}, persistent = true) {
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    detached: process.platform !== "win32",
    ...options,
  });
  children.push(child);
  child.once("error", (error) => {
    console.error(error.message);
    void stop(1);
  });
  child.once("exit", (code) => {
    if (persistent && !stopping) void stop(code ?? 1);
  });
  return child;
}

async function run(command, args, options = {}) {
  const child = launch(command, args, options, false);
  const [code] = await once(child, "exit");
  if (code !== 0) await stop(1);
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
  // Only the unique directory allocated above is eligible for cleanup.
  const parent = resolve(tmpdir());
  if (resolve(state).startsWith(`${parent}${sep}openhands-foundation-e2e-`)) {
    try {
      rmSync(state, { recursive: true, force: true });
    } catch {
      console.warn("Test state retained:", state);
    }
  }
  process.exit(code);
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
process.once("uncaughtException", (error) => {
  console.error(error.message);
  void stop(1);
});
process.once("unhandledRejection", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  void stop(1);
});

// Do not contact or reconfigure an unrelated server already on a test port.
for (const port of [backendPort, frontendPort]) {
  await new Promise((accept, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(Number(port), "127.0.0.1", () => probe.close(accept));
  });
}
const fixture = join(sdk, "tests/e2e/foundation_fixture_server.py");
launch(python, [fixture, "--state-dir", state, "--port", backendPort], {
  cwd: sdk,
  env: { ...process.env, PYTHONUTF8: "1" },
});

const deadline = Date.now() + 120_000;
while (true) {
  try {
    const response = await fetch(`http://127.0.0.1:${backendPort}/ready`);
    if (response.ok) break;
  } catch {
    /* Wait for the fixture's lifespan to finish. */
  }
  if (Date.now() > deadline) {
    console.error("Foundation fixture did not become ready.");
    await stop(1);
  }
  await new Promise((done) => setTimeout(done, 200));
}

const settings = await fetch(`http://127.0.0.1:${backendPort}/api/settings`, {
  method: "PATCH",
  headers: {
    "Content-Type": "application/json",
    "X-Session-API-Key": process.env.FOUNDATION_E2E_SESSION_API_KEY,
  },
  body: JSON.stringify({
    misc_settings_diff: {
      app_preferences: { user_consents_to_analytics: false },
    },
  }),
});
if (!settings.ok) {
  console.error("Could not disable fixture analytics.");
  await stop(1);
}

await run(process.execPath, ["scripts/make-i18n-translations.cjs"], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
const frontendMode = process.env.FOUNDATION_E2E_FRONTEND_MODE ?? "static";
if (frontendMode === "static") {
  if (process.env.FOUNDATION_E2E_SKIP_BUILD !== "1") {
    await run(
      process.execPath,
      ["node_modules/@react-router/dev/bin.js", "build"],
      {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
        env: {
          ...process.env,
          VITE_MOCK_API: "false",
          VITE_DO_NOT_TRACK: "1",
          VITE_LOCK_TO_CLOUD: "",
        },
      },
    );
  }
  const backend = `http://127.0.0.1:${backendPort}`;
  const routes = [
    "/api",
    "/sockets",
    "/server_info",
    "/ready",
    "/alive",
    "/health",
  ].flatMap((path) => ["--route", `${path}=${backend}`]);
  launch(process.execPath, [
    "scripts/static-server.mjs",
    "--port",
    frontendPort,
    "--host",
    "127.0.0.1",
    "--dir",
    "build",
    "--disable-telemetry",
    "--session-api-key",
    process.env.FOUNDATION_E2E_SESSION_API_KEY,
    ...routes,
  ]);
} else {
  launch(
    process.execPath,
    [
      "node_modules/@react-router/dev/bin.js",
      "dev",
      "--port",
      frontendPort,
      "--host",
      "127.0.0.1",
    ],
    {
      env: {
        ...process.env,
        VITE_BACKEND_HOST: `127.0.0.1:${backendPort}`,
        VITE_FRONTEND_PORT: frontendPort,
        VITE_SESSION_API_KEY: process.env.FOUNDATION_E2E_SESSION_API_KEY,
        VITE_MOCK_API: "false",
        VITE_DO_NOT_TRACK: "1",
        VITE_ENABLE_BROWSER_TOOLS: "false",
        VITE_USE_TLS: "false",
        VITE_LOCK_TO_CLOUD: "",
      },
    },
  );
}
