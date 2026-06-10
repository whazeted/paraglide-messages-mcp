import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TranslationService } from "./core/service.js";
import { registerTools } from "./primitives/tools.js";
import { registerPrompts } from "./primitives/prompts.js";
import { registerResources } from "./primitives/resources.js";

export const SERVER_VERSION = "0.1.0";

/**
 * Creates the MCP server for the inlang project at `projectPath`. The MCP
 * surface (tools, prompts, resources) lives in primitives/, the translation
 * domain logic in core/; all primitives operate on the same
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
