import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
	buildWorkspaceMetadata: vi.fn(async (cwd: string) => `ws-meta:${cwd}`),
	getClineDefaultSystemPrompt: vi.fn(
		(input: { ide?: string; providerId?: string; metadata?: string; rootPath?: string }) =>
			`ide=${input.ide};provider=${input.providerId};meta=${input.metadata ?? ""};cwd=${input.rootPath}`,
	),
}));

vi.mock("@cline/core", () => ({
	ClineCore: { create: vi.fn() },
	TelemetryLoggerSink: class {},
	TelemetryService: class {},
	buildWorkspaceMetadata: sdkMocks.buildWorkspaceMetadata,
	createUserInstructionConfigService: vi.fn(),
	formatRulesForSystemPrompt: vi.fn(() => ""),
	getClineDefaultSystemPrompt: sdkMocks.getClineDefaultSystemPrompt,
	isRuleEnabled: vi.fn(() => true),
	resolveClineDataDir: vi.fn(() => "/tmp/cline"),
}));

vi.mock("../../../src/cline-sdk/cline-telemetry-service", () => ({
	getCliTelemetryService: vi.fn(),
}));

import { resolveClineSdkSystemPrompt } from "../../../src/cline-sdk/sdk-runtime-boundary";

describe("resolveClineSdkSystemPrompt", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sdkMocks.buildWorkspaceMetadata.mockResolvedValue("ws-meta:/tmp/worktree");
	});

	it("keeps ClinePass providerId and appends workspace metadata", async () => {
		const prompt = await resolveClineSdkSystemPrompt({
			cwd: "/tmp/worktree",
			providerId: "cline-pass",
			rules: "",
		});

		expect(sdkMocks.buildWorkspaceMetadata).toHaveBeenCalledWith("/tmp/worktree");
		expect(sdkMocks.getClineDefaultSystemPrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				ide: "Kanban",
				providerId: "cline-pass",
				rootPath: "/tmp/worktree",
				metadata: "ws-meta:/tmp/worktree",
			}),
		);
		expect(prompt).toContain("provider=cline-pass");
		expect(prompt).toContain("meta=ws-meta:/tmp/worktree");
	});

	it("keeps usage-billing cline providerId and appends workspace metadata", async () => {
		const prompt = await resolveClineSdkSystemPrompt({
			cwd: "/tmp/worktree-cline",
			providerId: "cline",
		});

		expect(sdkMocks.buildWorkspaceMetadata).toHaveBeenCalledWith("/tmp/worktree-cline");
		expect(sdkMocks.getClineDefaultSystemPrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "cline",
				metadata: "ws-meta:/tmp/worktree",
			}),
		);
		expect(prompt).toContain("provider=cline");
	});

	it("does not load workspace metadata for non-Cline-account providers", async () => {
		await resolveClineSdkSystemPrompt({
			cwd: "/tmp/worktree",
			providerId: "anthropic",
		});

		expect(sdkMocks.buildWorkspaceMetadata).not.toHaveBeenCalled();
		expect(sdkMocks.getClineDefaultSystemPrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "anthropic",
				metadata: "",
			}),
		);
	});
});
