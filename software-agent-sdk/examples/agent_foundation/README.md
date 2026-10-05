# Two business packages on one Agent Server

The research and operations packages each declare one entry coordinator and two
specialists. They use the same canonical Profile resolver, SDK conversation loop,
managed delegation, approvals, and artifact store. Only prompts, skills, tools,
and references differ. The sample tools use fixture data; no business service is
contacted and no real ticket is created.

From the repository root, start the server with deployment-installed tools:

```sh
uv run python -m examples.agent_foundation.serve --port 8000
```

Save an LLM profile named `business` through the existing Profiles settings/API.
Then install each package through `POST /api/agent-foundation/packages/install`
with `{"source": "<absolute path to examples/agent_foundation/research>"}` and
the corresponding `operations` path. Package paths refer to the server machine.
Configure the usual session API key header if server authentication is enabled.

Create a task through `POST /api/agent-foundation/tasks` using
`{"agent_id":"research/coordinator","task":"Compare the two options and prepare a brief.","idempotency_key":"research-demo-1"}`
or `{"agent_id":"operations/coordinator","task":"Review the queue and propose an escalation.","idempotency_key":"operations-demo-1"}`.
The ordinary task and approval endpoints expose progress and decisions; the final
report is published as a managed artifact. Agent config GET is read-only and
shows the package hash, canonical profile, and current resolved model.

`demo_tools.py` must be imported in every server process before package validation
and conversation restore. Packages never install or import Python code. Replace
these deployment-installed tools with actual business integrations and keep
their registration names stable. Tool implementations, LLM profiles, credentials,
and remote MCP services are deployment dependencies, not part of the package
snapshot. Package versions preserve prompts/skills/manifest resources and do not
promise a reproducible external runtime.

The optional `ui_extension_ref` points to a separately installed Canvas Extension.
These examples reference `business-foundation-ui`; see `ui/README.md` for its
input form and result cards. The business package installer does not execute or
install frontend JavaScript. Generic task, approval, and artifact views work
without this optional extension.

Package upgrades require a new version. Disabling or uninstalling prevents new
entry tasks; immutable historical resources are retained for existing task
provenance. To test without provider calls, run the deterministic example tests
in `tests/agent_server/test_foundation_examples.py`.
