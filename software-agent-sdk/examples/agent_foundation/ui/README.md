# Optional business UI

This is an ordinary, independently installed Canvas Extension for the adjacent
`research` and `operations` business packages. It introduces no additional
runtime or UI protocol. The ES module needs no build step or npm dependencies.

1. Start the example Agent Server and install/enable the research and operations
   packages as described in the parent README.
2. In Canvas Apps, install this directory using its absolute **server-side** path
   and enable `business-foundation-ui`.
3. Open **Business tasks** in the extension navigation. Select a business area and
   describe the task. The form calls `host.foundation.createTask` with a stable
   idempotency key and opens the real task conversation.

The manifest registers four exact result scopes: `business_write_report` and
`task_result` for each example package, all at schema version 1. The current
foundation runtime emits the latter envelope with tool observations in `data`;
the report scopes are also ready for individual tool-result presentations.
Cards display the summary, expandable structured details, and artifact names.
Downloads remain in Canvas's task artifact panel. Missing, disabled, or failed
renderers fall back to Canvas's text, JSON, and downloadable artifacts.

The form only uses the optional host capability. It never reads credentials or
constructs an Agent Server HTTP request. It preserves the same request key after
an uncertain network outcome and ignores navigation after its page is disposed.
The `ui_extension_ref` in a business manifest is descriptive only: it does not
install or enable this JavaScript bundle.

Run the focused registration and form-submission tests with Node 22+:

```sh
node --test examples/agent_foundation/ui/extension.test.mjs
```
