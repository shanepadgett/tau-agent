import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		include: ["packages/agent/test/**/*.test.ts"],
		environment: "node",
		testTimeout: 30000,
	},
});
