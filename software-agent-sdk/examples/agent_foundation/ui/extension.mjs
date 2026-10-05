/** @spec GAF-006 — An ordinary Canvas extension consumes optional v1 host APIs. */
const ENTRY_AGENTS = ["research/coordinator", "operations/coordinator"];
const RENDERER_IDS = ["research-report", "operations-report", "research-task", "operations-task"];

/** Retain the request identity when a network error leaves the outcome uncertain. */
export function createTaskSubmitter(foundation) {
  let request;
  return async (agentId, text) => {
    const task = text.trim();
    if (!ENTRY_AGENTS.includes(agentId) || !task) throw new Error("Choose a business area and describe the task.");
    if (request?.agent_id !== agentId || request?.task !== task) {
      request = { agent_id: agentId, task, idempotency_key: crypto.randomUUID() };
    }
    return foundation.createTask(request);
  };
}

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function panel(container) {
  const section = element("section");
  Object.assign(section.style, { maxWidth: "48rem", padding: "1.5rem", margin: "auto", display: "grid", gap: "1rem", fontFamily: "inherit" });
  container.replaceChildren(section);
  return section;
}

function mountForm(host, { container }) {
  const section = panel(container);
  section.append(element("h1", "Start a business task"));
  if (!host.foundation) {
    section.append(element("p", "This server does not provide the business task capability."));
    return () => section.remove();
  }
  const submitTask = createTaskSubmitter(host.foundation);
  const form = element("form");
  Object.assign(form.style, { display: "grid", gap: "1rem" });
  const areaLabel = element("label", "Business area ");
  const area = element("select");
  ["Research brief", "Operations review"].forEach((title, index) => {
    const option = element("option", title);
    option.value = ENTRY_AGENTS[index];
    area.append(option);
  });
  areaLabel.append(area);
  const taskLabel = element("label", "Task ");
  const task = element("textarea");
  task.required = true;
  task.rows = 5;
  task.placeholder = "Describe the evidence to compare or the operation to review.";
  Object.assign(task.style, { display: "block", width: "100%", padding: "0.75rem", color: "inherit", background: "transparent", border: "1px solid currentColor", borderRadius: "0.5rem" });
  taskLabel.append(task);
  const submit = element("button", "Start task");
  submit.type = "submit";
  const status = element("p");
  status.setAttribute("role", "status");
  let disposed = false;
  let busy = false;
  const onSubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    submit.disabled = area.disabled = task.disabled = true;
    status.textContent = "Starting task…";
    try {
      const created = await submitTask(area.value, task.value);
      if (disposed) return;
      if (!created.conversation_id) throw new Error("Task created without a conversation. Retry to retrieve the same task.");
      host.navigate(`/conversations/${encodeURIComponent(created.conversation_id)}`);
      status.textContent = "Task started.";
    } catch (error) {
      if (!disposed) status.textContent = error instanceof Error ? error.message : "Task could not be started. Retry with the same input.";
    } finally {
      busy = false;
      if (!disposed) submit.disabled = area.disabled = task.disabled = false;
    }
  };
  form.addEventListener("submit", onSubmit);
  form.append(areaLabel, taskLabel, submit, status);
  section.append(form);
  return () => { disposed = true; form.removeEventListener("submit", onSubmit); section.remove(); };
}

function mountReport({ container, result }) {
  const section = panel(container);
  section.append(element("h3", result.package_id === "research" ? "Research report" : "Operations report"));
  if (result.text) {
    const summary = element("p", result.text);
    summary.style.whiteSpace = "pre-wrap";
    section.append(summary);
  }
  const details = element("details");
  details.append(element("summary", "Report details"));
  const data = element("pre", typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2));
  Object.assign(data.style, { whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "20rem", overflow: "auto" });
  details.append(data);
  section.append(details);
  if (result.artifacts?.length) {
    const files = element("ul");
    for (const artifact of result.artifacts) files.append(element("li", artifact.name));
    section.append(files, element("p", "Download these files from the task's Files and results panel."));
  }
  return () => section.remove();
}

export function activate(host) {
  const disposers = [host.registerPage("business-task", (context) => mountForm(host, context))];
  if (host.registerResultRenderer) {
    for (const id of RENDERER_IDS) disposers.push(host.registerResultRenderer(id, mountReport));
  }
  return () => disposers.reverse().forEach((dispose) => dispose());
}
