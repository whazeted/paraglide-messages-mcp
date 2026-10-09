#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { BatchTranslationService } from "./core/batch.js";
import { discoverProjectPath } from "./core/project.js";
import { createServer, SERVER_VERSION } from "./server.js";

const HELP = `paraglide-messages-mcp ${SERVER_VERSION}
MCP server (stdio) for translating Paraglide JS / inlang projects.

Usage:
  npx paraglide-messages-mcp [--project <path>] [--translation-style <brief>] [--model <id>]
  npx paraglide-messages-mcp --project <path> --resume

Options:
  --project <path>  Path to the inlang project directory. Defaults to
                    ./project.inlang or the single *.inlang directory found
                    up to one level deep.
  --translation-style <brief>
                    Tone, formality and terminology supplied to OpenAI.
  --model <id>      Batch model (default gpt-6-luna, reasoning effort low).
  --jobs-dir <path> Durable job directory (default project.inlang/.paraglide-batches).
  --resume          Reconcile all unfinished jobs once and exit; suitable for a scheduler.
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
	const model = readOption(argv, "--model");
	const jobsDirectory = readOption(argv, "--jobs-dir");

	if (translationStyle === "") {
		process.stderr.write("error: --translation-style requires a non-empty brief\n");
		process.exit(1);
	}

	const projectPath = discoverProjectPath({
		cwd: process.cwd(),
		explicitPath,
	});

	const options = { translationStyle, model, jobsDirectory };
	if (argv.includes("--resume")) {
		const batches = new BatchTranslationService(projectPath, options);
		let after: string | undefined;
		let failed = false;
		do {
			const page = batches.list({ after, limit: 100 });
			for (const job of page.jobs) {
				if (job.cleanedUp) continue;
				try {
					const result = await batches.get(job.jobId);
					process.stdout.write(JSON.stringify(result) + "\n");
					if (result.lastError || result.failed) failed = true;
				} catch (error) {
					failed = true;
					process.stderr.write(`job ${job.jobId}: ${String(error)}\n`);
				}
			}
			after = page.nextCursor;
		} while (after);
		process.exitCode = failed ? 1 : 0;
		return;
	}

	// stdout is reserved for the MCP protocol — log to stderr only
	process.stderr.write(`paraglide-messages-mcp: serving project at ${projectPath}\n`);

	const handle = serveStdio(() => createServer(projectPath, options));
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => { void handle.close(); });
	}
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
