import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TranslationService } from "./core/service.js";
import { registerTools } from "./primitives/tools.js";
import { registerPrompts } from "./primitives/prompts.js";
import { registerResources } from "./primitives/resources.js";

export const SERVER_VERSION = "0.2.2";

export interface ServerOptions {
	/**
	 * Linguistic style brief supplied by the MCP client at server startup.
	 * Prompts and project_info expose it so agents do not infer style from
	 * existing translations.
	 */
	translationStyle?: string;
}

/**
 * Creates the MCP server for the inlang project at `projectPath`. The MCP
 * surface (tools, prompts, resources) lives in primitives/, the translation
 * domain logic in core/; all primitives operate on the same
 * TranslationService.
 */
export function createServer(
	projectPath: string,
	options: ServerOptions = {}
): McpServer {
	const service = new TranslationService(projectPath, {
		translationStyle: options.translationStyle?.trim() || undefined,
	});

	const server = new McpServer({
		name: "paraglide-messages-mcp",
		version: SERVER_VERSION,
	});

	registerTools(server, service);
	registerPrompts(server, service, {
		translationStyle: service.translationStyle,
	});
	registerResources(server, service);

	return server;
}
