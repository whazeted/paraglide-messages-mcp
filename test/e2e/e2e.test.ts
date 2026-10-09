import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { BatchTranslationService } from "../../src/core/batch.js";
import { FakeOpenAI } from "../shared/openai.js";
import { afterEach, describe, expect, it } from "vitest";
import { Client, PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createFixtureProject, removeFixture } from "../shared/helpers.js";

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/cli.js");
const fixtures: ReturnType<typeof createFixtureProject>[] = [];
const clients: Client[] = [];

afterEach(async () => {
	await Promise.all(clients.splice(0).map(client => client.close()));
	for (const fixture of fixtures.splice(0)) removeFixture(fixture.rootDir);
});

async function connect() {
	const fixture = createFixtureProject(); fixtures.push(fixture);
	const client = new Client({ name: "e2e", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); clients.push(client);
	await client.connect(new StdioClientTransport({ command: process.execPath,
		args: [cliPath, "--project", fixture.projectPath, "--translation-style", "Concise UI"], stderr: "pipe" }));
	return { fixture, client };
}

describe("stdio MCP v2", () => {
	it("collects a persisted job through the one-pass CLI worker", async () => {
		const fixture = createFixtureProject(); fixtures.push(fixture);
		const fake = new FakeOpenAI();
		await new BatchTranslationService(fixture.projectPath, { openai: fake.client }).start({ jobId: "worker-fr", targetLocales: ["fr"] });
		fake.finish();
		const server = createHttpServer(async (req, res) => {
			try {
				const response = await fake.fetch(new URL(req.url!, "http://local.test"), { method: req.method });
				res.writeHead(response.status, Object.fromEntries(response.headers));
				res.end(await response.text());
			} catch (error) { res.writeHead(500); res.end(String(error)); }
		});
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address() as { port: number };
			const child = spawn(process.execPath, [cliPath, "--project", fixture.projectPath, "--resume"], {
				env: { ...process.env, OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "", errors = "";
			child.stdout.on("data", data => { output += data; });
			child.stderr.on("data", data => { errors += data; });
			const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
			expect(errors).toBe(""); expect(code).toBe(0);
			expect(JSON.parse(output.trim())).toMatchObject({ jobId: "worker-fr", saved: 6, failed: 0, cleanedUp: true });
			expect(fixture.readMessages("fr").greeting).toBe("FR:Hello {name}!");
		} finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
	});

	it("serves the smaller tool surface and validates writes on disk", async () => {
		const { fixture, client } = await connect();
		expect(client.getProtocolEra()).toBe("modern");
		const { tools } = await client.listTools();
		expect(tools.map(t => t.name).sort()).toEqual([
			"cancel_translation_job", "get_messages", "get_translation_job", "list_message_keys",
			"list_translation_jobs", "project_info", "save_translations", "search_messages", "start_translation_job",
		]);
		const info = await client.callTool({ name: "project_info", arguments: {} });
		expect(info.structuredContent).toMatchObject({ baseLocale: "en", translationStyle: "Concise UI" });
		const invalid = await client.callTool({ name: "save_translations", arguments: {
			targetLocale: "fr", translations: [{ key: "greeting", value: "Bonjour {nom}" }],
		} });
		expect(invalid.structuredContent).toMatchObject({ saved: 0, failed: 1 });
		const saved = await client.callTool({ name: "save_translations", arguments: {
			targetLocale: "fr", translations: [{ key: "greeting", value: "Bonjour {name}" }],
		} });
		expect(saved.structuredContent).toMatchObject({ saved: 1, failed: 0 });
		expect(fixture.readMessages("fr").greeting).toBe("Bonjour {name}");
		const jobs = await client.callTool({ name: "list_translation_jobs", arguments: {} });
		expect(jobs.structuredContent).toEqual({ jobs: [], hasMore: false });
	});

	it.each(["server/discover", "initialize"])("accepts %s openings on the real CLI", async method => {
		const fixture = createFixtureProject(); fixtures.push(fixture);
		const child = spawn(process.execPath, [cliPath, "--project", fixture.projectPath], { stdio: ["pipe", "pipe", "pipe"] });
		try {
			const reply = new Promise<string>((resolve, reject) => {
				let text = "";
				child.stdout.on("data", data => { text += data; if (text.includes("\n")) resolve(text.split("\n")[0]!); });
				child.on("error", reject);
				child.on("exit", code => reject(new Error(`server exited: ${code}`)));
			});
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method,
				params: method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } : {
					_meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_INFO_META_KEY]: { name: "modern", version: "1" }, [CLIENT_CAPABILITIES_META_KEY]: {} },
				},
			}) + "\n");
			const response = JSON.parse(await reply);
			expect(response.error).toBeUndefined();
			if (method === "initialize") expect(response.result.protocolVersion).toBe("2025-11-25");
			else expect(JSON.stringify(response.result)).toContain("2026-07-28");
		} finally {
			const closed = new Promise(resolve => child.once("exit", resolve));
			child.stdin.end();
			await closed;
		}
	});
});
