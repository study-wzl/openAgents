"""Deterministic MCP process exercising structured output and embedded resources."""

import base64

from fastmcp import FastMCP
from fastmcp.tools.tool import ToolResult
from mcp.types import BlobResourceContents, EmbeddedResource, TextContent


server = FastMCP("foundation-artifact-fixture")


@server.tool()
def report() -> ToolResult:
    """Return a structured report and an embedded file."""
    return ToolResult(
        content=[
            TextContent(type="text", text="Report ready"),
            EmbeddedResource(
                type="resource",
                resource=BlobResourceContents(
                    uri="file:///untrusted-host/report.csv",
                    mimeType="text/csv",
                    blob=base64.b64encode(b"metric,value\norders,7\n").decode(),
                ),
            ),
        ],
        structured_content={"orders": 7},
    )


if __name__ == "__main__":
    server.run(transport="stdio", show_banner=False)
