import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TranslationService } from "./service.js";
import { registerTools } from "./tools.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";

export const SERVER_VERSION = "0.1.0";

/**
 * Creates the MCP server for the inlang project at `projectPath`. The
 * translation tools live in tools.ts, the workflow prompts in prompts.ts,
 * the read-only resources in resources.ts; all operate on the same
 * TranslationService.
 */
export function createServer(projectPath: string): McpServer {
	const service = new TranslationService(projectPath);

	const server = new McpServer({
		name: "paraglide-mcp",
		version: SERVER_VERSION,
	});

	registerTools(server, service);
	registerPrompts(server, service);
	registerResources(server, service);

	return server;
}
