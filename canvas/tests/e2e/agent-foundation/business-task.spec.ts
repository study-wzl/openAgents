import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const key = process.env.FOUNDATION_E2E_SESSION_API_KEY!;
const headers = { "X-Session-API-Key": key };
const prefix = "/api/agent-foundation";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("analytics-consent", "false");
    localStorage.setItem("openhands-telemetry-consent", "denied");
    localStorage.setItem("openhands-telemetry-first-use", "true");
    localStorage.setItem("openhands-onboarded", "1");
    localStorage.setItem("i18nextLng", "en");
  });
});

// @spec GAF-002 — Browser tasks execute two real specialists through the SDK.
// @spec GAF-003 — Approval and rejection survive browser reloads.
// @spec GAF-004 — A completed report downloads through the authenticated API.
for (const approved of [true, false]) {
  test(`${approved ? "approve" : "reject"} an operation, reload, and download the report`, async ({
    page,
    request,
  }) => {
    const analytics: string[] = [];
    await page.route(
      /^https?:\/\/(?:(?:[^/]+\.)*posthog\.com|z\.openhands\.dev)(?:\/|$)/,
      async (route) => {
        analytics.push(route.request().url());
        await route.abort();
      },
    );
    await page.goto("/");
    const home = page.getByTestId("agent-foundation-home");
    await expect(home).toBeVisible();
    await home
      .getByRole("button", { name: "Operations coordinator", exact: true })
      .click();
    await home
      .getByRole("textbox", { name: "What would you like to accomplish?" })
      .fill("Review operations with both specialists and prepare a report.");
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith(`${prefix}/tasks`) &&
        response.request().method() === "POST",
    );
    await home.getByRole("button", { name: "Start task", exact: true }).click();
    const creation = await created;
    expect(creation.ok()).toBeTruthy();
    const task = (await creation.json()) as {
      id: string;
      conversation_id: string;
    };
    await expect(page).toHaveURL(
      new RegExp(`/conversations/${task.conversation_id}$`),
    );
    const panel = page.getByTestId("agent-foundation-task-panel");
    await expect(
      panel.getByText("operations/metrics", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByText("operations/runbook", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Approve", exact: true }),
    ).toBeVisible();

    // A browser reload must discover the existing server-owned approval.
    await page.reload();
    await expect(
      panel.getByRole("button", { name: "Approve", exact: true }),
    ).toBeVisible();
    await panel
      .getByRole("button", {
        name: approved ? "Approve" : "Reject",
        exact: true,
      })
      .click();
    await expect
      .poll(async () => {
        const response = await request.get(`${prefix}/tasks/${task.id}`, {
          headers,
        });
        return (await response.json()).status;
      })
      .toBe("completed");
    const approvalsResponse = await request.get(
      `${prefix}/approvals?conversation_id=${task.conversation_id}`,
      { headers },
    );
    const approvals = (await approvalsResponse.json()).approvals as Array<{
      call_id: string;
      status: string;
    }>;
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe(approved ? "approved" : "rejected");
    const callsResponse = await request.get(
      `${prefix}/tasks/${task.id}/calls`,
      { headers },
    );
    const calls = (await callsResponse.json()).calls as Array<{ id: string }>;
    expect(calls.some((call) => call.id === approvals[0].call_id)).toBe(
      approved,
    );

    await page.reload();
    const files = panel.getByRole("region", { name: "Files and results" });
    const downloadPromise = page.waitForEvent("download");
    await files
      .getByRole("button", { name: "Download report.md", exact: true })
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("report.md");
    const path = await download.path();
    expect(path).not.toBeNull();
    expect(await readFile(path!, "utf8")).toContain(
      "Two specialists reviewed demonstration evidence.",
    );
    const records = await request.get(
      `${prefix}/tasks?conversation_id=${task.conversation_id}`,
      { headers },
    );
    expect((await records.json()).tasks).toHaveLength(3);
    expect(analytics).toEqual([]);
  });
}
