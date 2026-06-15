#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { discoverProjectPath } from "./core/project.js";
import { createServer, SERVER_VERSION } from "./server.js";

const HELP = `paraglide-messages-mcp ${SERVER_VERSION}
MCP server (stdio) for translating Paraglide JS / inlang projects.

Usage:
  npx paraglide-messages-mcp [--project <path/to/project.inlang>] [--translation-style <brief>]

Options:
  --project <path>  Path to the inlang project directory. Defaults to
                    ./project.inlang or the single *.inlang directory found
                    up to one level deep.
  --translation-style <brief>
                    Linguistic style brief agents should use for translations
                    (tone, formality, terminology). When omitted, prompts ask
                    the user instead of deriving style from existing translations.
  --help            Show this help.
  --version         Print the version.

Example MCP client configuration (.mcp.json / claude_desktop_config.json):
  {
    "mcpServers": {
      "paraglide": {
        "command": "npx",
        "args": [
          "-y",
          "paraglide-messages-mcp",
          "--project",
          "./project.inlang",
          "--translation-style",
          "Concise product UI; informal address; keep brand terms untranslated."
        ]
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

	const explicitPath = readOption(argv, "--project");
	const translationStyle = readOption(argv, "--translation-style")?.trim();

	if (translationStyle === "") {
		process.stderr.write("error: --translation-style requires a non-empty brief\n");
		process.exit(1);
	}

	const projectPath = discoverProjectPath({
		cwd: process.cwd(),
		explicitPath,
	});

	// stdout is reserved for the MCP protocol — log to stderr only
	process.stderr.write(`paraglide-messages-mcp: serving project at ${projectPath}\n`);

	const server = createServer(projectPath, { translationStyle });
	await server.connect(new StdioServerTransport());
}

function readOption(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	if (index === -1) return undefined;

	const value = argv[index + 1];
	if (!value || value.startsWith("--")) {
		process.stderr.write(`error: ${flag} requires an argument\n`);
		process.exit(1);
	}
	return value;
}

main().catch((error) => {
	process.stderr.write(`paraglide-messages-mcp: ${error?.message ?? error}\n`);
	process.exit(1);
});
