#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { discoverProjectPath } from "./project.js";
import { createServer, SERVER_VERSION } from "./server.js";

const HELP = `paraglide-mcp ${SERVER_VERSION}
MCP server (stdio) for translating Paraglide JS / inlang projects.

Usage:
  npx paraglide-mcp [--project <path/to/project.inlang>]

Options:
  --project <path>  Path to the inlang project directory. Defaults to
                    ./project.inlang or the single *.inlang directory found
                    up to one level deep.
  --help            Show this help.
  --version         Print the version.

Example MCP client configuration (.mcp.json / claude_desktop_config.json):
  {
    "mcpServers": {
      "paraglide": {
        "command": "npx",
        "args": ["-y", "paraglide-mcp", "--project", "./project.inlang"]
      }
    }
  }
`;

async function main() {
	const argv = process.argv.slice(2);

	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(HELP);
		return;
	}
	if (argv.includes("--version") || argv.includes("-v")) {
		process.stdout.write(SERVER_VERSION + "\n");
		return;
	}

	let explicitPath: string | undefined;
	const projectFlagIndex = argv.indexOf("--project");
	if (projectFlagIndex !== -1) {
		explicitPath = argv[projectFlagIndex + 1];
		if (!explicitPath || explicitPath.startsWith("--")) {
			process.stderr.write("error: --project requires a path argument\n");
			process.exit(1);
		}
	}

	const projectPath = discoverProjectPath({
		cwd: process.cwd(),
		explicitPath,
	});

	// stdout is reserved for the MCP protocol — log to stderr only
	process.stderr.write(`paraglide-mcp: serving project at ${projectPath}\n`);

	const server = createServer(projectPath);
	await server.connect(new StdioServerTransport());
}

main().catch((error) => {
	process.stderr.write(`paraglide-mcp: ${error?.message ?? error}\n`);
	process.exit(1);
});
