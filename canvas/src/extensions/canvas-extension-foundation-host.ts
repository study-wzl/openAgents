import { ConversationClient } from "@openhands/typescript-client/clients";
import FoundationService from "#/api/agent-foundation-service";
import { getAgentServerClientOptions } from "#/api/agent-server-client-options";
import type { Backend } from "#/api/backend-registry/types";
import type { CanvasExtensionFoundationHost } from "#/types/canvas-extension";

// @spec GAF-006 — Form actions remain bound to their extension activation backend.
export function createCanvasExtensionFoundationHost(
  backend: Backend,
  assertActive: () => void,
): CanvasExtensionFoundationHost {
  return {
    async createTask(input) {
      assertActive();
      return FoundationService.createTask(input, backend);
    },
    async getTask(id) {
      assertActive();
      return FoundationService.getTask(id, backend);
    },
    async uploadArtifact(conversationId, file) {
      assertActive();
      return FoundationService.uploadArtifact(conversationId, file, backend);
    },
    async sendInput(conversationId, text) {
      assertActive();
      await new ConversationClient(
        getAgentServerClientOptions({
          host: backend.host,
          apiKey: backend.apiKey ?? "",
        }),
      ).sendEvent(
        conversationId,
        { role: "user", content: [{ type: "text", text }] },
        { run: true },
      );
    },
  };
}
