import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 60_000,
		hookTimeout: 60_000,
		// the inlang SDK uses sqlite-wasm; keep tests in a single fork to
		// avoid concurrent wasm instantiation flakiness
		pool: "forks",
		poolOptions: {
			forks: {
				singleFork: true,
			},
		},
	},
});
