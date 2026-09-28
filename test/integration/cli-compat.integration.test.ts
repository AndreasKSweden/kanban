import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const requireFromHere = createRequire(import.meta.url);

function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

describe("cli compatibility flags", () => {
	it("disables remote passcode authentication with --no-passcode", () => {
		const root = mkdtempSync(join(tmpdir(), "kanban-cli-no-passcode-"));
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: root,
			KANBAN_RUNTIME_HOME: join(root, "runtime"),
			KANBAN_WORKTREES_HOME: join(root, "worktrees"),
		};
		delete env.KANBAN_RUNTIME_HOST;
		delete env.KANBAN_RUNTIME_PORT;

		try {
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--host",
					"0.0.0.0",
					"--port",
					"auto",
					"--no-open",
					"--no-passcode",
					"--skip-shutdown-cleanup",
				],
				{
					encoding: "utf8",
					env,
					timeout: 4_000,
				},
			);

			expect(result.stdout).toContain("Passcode authentication disabled (--no-passcode).");
			expect(result.stdout).not.toContain("Remote access passcode:");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts the deprecated --agent flag as a no-op", () => {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				resolveTsxLoaderImportSpecifier(),
				resolve(process.cwd(), "src/cli.ts"),
				"--agent",
				"legacy-alias-value",
				"--help",
			],
			{
				encoding: "utf8",
			},
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("--port");
		expect(result.stdout).not.toContain("--agent");
		expect(result.stdout).not.toContain("Agent IDs:");
	});
});
