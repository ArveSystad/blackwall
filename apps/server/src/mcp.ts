import { VOICE_TOOLS, VoiceToolError, type VoiceCommandService } from "@blackwall/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { APP_NAME } from "@blackwall/shared";
import { Hono } from "hono";

/** The voice command service as the MCP route uses it. */
export type McpCommandService = Pick<VoiceCommandService, "authorize" | "callTool">;

/** The bearer token of an `Authorization` header, if any. */
function bearer(header: string | undefined): string | undefined {
  const match = /^Bearer (\S+)$/i.exec(header?.trim() ?? "");
  return match?.[1];
}

/**
 * blackwall's own MCP server, mounted at `/mcp` outside `/api` (so outside the
 * launch-token cookie; the host guard still applies). Only voice turns reach
 * it: each request needs the bearer token of a running turn (401 otherwise),
 * and its tools act for that turn's repo. Stateless streamable HTTP with JSON
 * responses: every request gets its own server and transport.
 */
export function mcpRoutes(commands: McpCommandService): Hono {
  const routes = new Hono();

  routes.all("/", async (c) => {
    const access = commands.authorize(bearer(c.req.header("authorization")));
    if (!access) return c.json({ error: "unauthorized" }, 401);
    const server = new McpServer({ name: APP_NAME, version: "1.0.0" });
    for (const tool of VOICE_TOOLS) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.input },
        async (input: unknown) => {
          try {
            const text = await commands.callTool(access, tool.name, input);
            return { content: [{ type: "text" as const, text }] };
          } catch (error) {
            if (!(error instanceof VoiceToolError)) throw error;
            return { content: [{ type: "text" as const, text: error.message }], isError: true };
          }
        },
      );
    }
    // No session id generator: stateless.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });

  return routes;
}
