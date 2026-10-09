import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { TranslationService } from "./core/service.js";
import { BatchTranslationService, type BatchOptions } from "./core/batch.js";
import { registerTools } from "./primitives/tools.js";

export const SERVER_VERSION = "0.3.0";

export type ServerOptions = BatchOptions;

/**
 * Creates the MCP server for the inlang project at `projectPath`. The MCP
 * tools live in primitives/; file validation and durable jobs live in core/.
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

	registerTools(server, service, new BatchTranslationService(projectPath, options));

	return server;
}

/** Web-standard HTTP entry: a fresh server per request, no protocol session. */
export function createHandler(projectPath: string, options: ServerOptions = {}) {
	return createMcpHandler(() => createServer(projectPath, options), { responseMode: "json" });
}
