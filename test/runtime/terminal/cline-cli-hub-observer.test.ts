import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";

import { type ClineCliHubRunEvent, createClineCliHubObserver } from "../../../src/terminal/cline-cli-hub-observer";

const servers: WebSocketServer[] = [];
const tempRoots: string[] = [];

async function startHub(): Promise<{ server: WebSocketServer; url: string }> {
	const server = new WebSocketServer({
		host: "127.0.0.1",
		port: 0,
	});
	servers.push(server);

	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("listening", resolvePromise);
		server.once("error", rejectPromise);
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Unable to resolve test Hub address");
	}

	return {
		server,
		url: `ws://127.0.0.1:${address.port}/hub`,
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for test condition");
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	}
}

function frameCommand(frame: Record<string, unknown>): string | null {
	if (frame.kind !== "command") {
		return null;
	}

	const envelope = frame.envelope;
	if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
		return null;
	}

	const command = (envelope as Record<string, unknown>).command;
	return typeof command === "string" ? command : null;
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		for (const client of server.clients) {
			client.terminate();
		}
		await new Promise<void>((resolvePromise) => {
			server.close(() => resolvePromise());
		});
	}

	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("Cline CLI Hub observer", () => {
	it("subscribes to the newest matching CLI session from the pre-launch cursor and forwards run events", async () => {
		const root = mkdtempSync(join(tmpdir(), "kanban-cline-hub-"));
		tempRoots.push(root);

		const cwd = join(root, "worktree");
		mkdirSync(cwd, { recursive: true });

		const { server, url } = await startHub();
		const discoveryPath = join(root, "production.json");
		writeFileSync(discoveryPath, JSON.stringify({ url }), "utf8");

		const preparedAt = Date.now();
		const receivedFrames: Record<string, unknown>[] = [];
		let resolveClientSocket!: (socket: WebSocket) => void;
		const clientSocketPromise = new Promise<WebSocket>((resolvePromise) => {
			resolveClientSocket = resolvePromise;
		});

		server.on("connection", (socket) => {
			resolveClientSocket(socket);

			socket.on("message", (raw) => {
				const parsed: unknown = JSON.parse(String(raw));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					return;
				}

				const frame = parsed as Record<string, unknown>;
				receivedFrames.push(frame);

				if (frame.kind !== "command") {
					return;
				}

				const envelope = frame.envelope;
				if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
					return;
				}

				const request = envelope as Record<string, unknown>;
				const requestId = request.requestId;
				const command = request.command;

				if (typeof requestId !== "string" || typeof command !== "string") {
					return;
				}

				let payload: Record<string, unknown> = {};

				if (command === "hub.status") {
					payload = {
						eventLog: {
							lastSequence: 41,
						},
					};
				} else if (command === "session.list") {
					payload = {
						sessions: [
							{
								sessionId: "wrong-source",
								cwd,
								workspaceRoot: cwd,
								createdAt: preparedAt + 100,
								metadata: { source: "extension" },
							},
							{
								sessionId: "too-old",
								cwd,
								workspaceRoot: cwd,
								createdAt: preparedAt - 1,
								metadata: { source: "cli" },
							},
							{
								sessionId: "wrong-cwd",
								cwd: join(root, "other"),
								workspaceRoot: join(root, "other"),
								createdAt: preparedAt + 200,
								metadata: { source: "cli" },
							},
							{
								sessionId: "matching-older",
								cwd,
								workspaceRoot: cwd,
								createdAt: preparedAt + 10,
								metadata: { source: "cli" },
							},
							{
								sessionId: "matching-newest",
								cwd,
								workspaceRoot: cwd,
								createdAt: preparedAt + 20,
								metadata: { source: "cli" },
							},
						],
					};
				}

				socket.send(
					JSON.stringify({
						kind: "reply",
						envelope: {
							requestId,
							ok: true,
							payload,
						},
					}),
				);
			});
		});

		const events: ClineCliHubRunEvent[] = [];
		let releaseStarted!: () => void;
		const startedGate = new Promise<void>((resolvePromise) => {
			releaseStarted = resolvePromise;
		});
		const onRunEvent = vi.fn(async (event: ClineCliHubRunEvent) => {
			if (event === "run.started") {
				await startedGate;
			}
			events.push(event);
		});

		const observer = await createClineCliHubObserver({
			cwd,
			env: {
				CLINE_HUB_DISCOVERY_PATH: discoveryPath,
			},
			preparedAt,
			onRunEvent,
		});

		await observer.start();

		await waitFor(() =>
			receivedFrames.some((frame) => frame.kind === "stream.subscribe" && frame.sessionId === "matching-newest"),
		);

		const subscribe = receivedFrames.find(
			(frame) => frame.kind === "stream.subscribe" && frame.sessionId === "matching-newest",
		);

		expect(subscribe).toMatchObject({
			kind: "stream.subscribe",
			sessionId: "matching-newest",
			sinceSequence: 41,
		});

		expect(receivedFrames.some((frame) => frameCommand(frame) === "client.register")).toBe(true);
		expect(receivedFrames.some((frame) => frameCommand(frame) === "hub.status")).toBe(true);
		expect(receivedFrames.some((frame) => frameCommand(frame) === "session.list")).toBe(true);

		const socket = await clientSocketPromise;

		socket.send(
			JSON.stringify({
				kind: "event",
				envelope: {
					event: "run.completed",
					sessionId: "some-other-session",
					sequence: 42,
				},
			}),
		);

		socket.send(
			JSON.stringify({
				kind: "event",
				envelope: {
					event: "run.started",
					sessionId: "matching-newest",
					sequence: 43,
				},
			}),
		);

		socket.send(
			JSON.stringify({
				kind: "event",
				envelope: {
					event: "run.completed",
					sessionId: "matching-newest",
					sequence: 44,
				},
			}),
		);

		await waitFor(() => onRunEvent.mock.calls.length >= 1);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));

		// Run events must be delivered serially. run.completed must not begin
		// until the async run.started handler has finished.
		expect(onRunEvent).toHaveBeenCalledTimes(1);
		expect(events).toEqual([]);

		releaseStarted();
		await waitFor(() => events.length === 2);

		expect(events).toEqual(["run.started", "run.completed"]);
		expect(onRunEvent).toHaveBeenCalledTimes(2);

		await observer.dispose();

		expect(
			receivedFrames.some((frame) => frame.kind === "stream.unsubscribe" && frame.sessionId === "matching-newest"),
		).toBe(true);
		expect(receivedFrames.some((frame) => frameCommand(frame) === "client.unregister")).toBe(true);
	});

	it("does not fail creation when Hub discovery is unavailable before launch", async () => {
		const root = mkdtempSync(join(tmpdir(), "kanban-cline-hub-missing-"));
		tempRoots.push(root);

		const observer = await createClineCliHubObserver({
			cwd: root,
			env: {
				CLINE_HUB_DISCOVERY_PATH: join(root, "does-not-exist.json"),
			},
			preparedAt: Date.now(),
			onRunEvent: vi.fn(),
		});

		await observer.dispose();
	});

	it("reconnects after a Hub disconnect and resumes from the latest event sequence", async () => {
		const root = mkdtempSync(join(tmpdir(), "kanban-cline-hub-reconnect-"));
		tempRoots.push(root);

		const cwd = join(root, "worktree");
		mkdirSync(cwd, { recursive: true });

		const { server, url } = await startHub();
		const discoveryPath = join(root, "production.json");
		writeFileSync(discoveryPath, JSON.stringify({ url }), "utf8");

		const preparedAt = Date.now();
		const receivedFrames: Record<string, unknown>[] = [];
		const sockets: WebSocket[] = [];

		server.on("connection", (socket) => {
			sockets.push(socket);

			socket.on("message", (raw) => {
				const parsed: unknown = JSON.parse(String(raw));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					return;
				}

				const frame = parsed as Record<string, unknown>;
				receivedFrames.push(frame);

				if (frame.kind !== "command") {
					return;
				}

				const envelope = frame.envelope;
				if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
					return;
				}

				const request = envelope as Record<string, unknown>;
				const requestId = request.requestId;
				const command = request.command;

				if (typeof requestId !== "string" || typeof command !== "string") {
					return;
				}

				let payload: Record<string, unknown> = {};

				if (command === "hub.status") {
					payload = {
						eventLog: {
							lastSequence: 41,
						},
					};
				} else if (command === "session.list") {
					payload = {
						sessions: [
							{
								sessionId: "matching-session",
								cwd,
								workspaceRoot: cwd,
								createdAt: preparedAt + 10,
								metadata: { source: "cli" },
							},
						],
					};
				}

				socket.send(
					JSON.stringify({
						kind: "reply",
						envelope: {
							requestId,
							ok: true,
							payload,
						},
					}),
				);
			});
		});

		const events: ClineCliHubRunEvent[] = [];
		const observer = await createClineCliHubObserver({
			cwd,
			env: {
				CLINE_HUB_DISCOVERY_PATH: discoveryPath,
			},
			preparedAt,
			onRunEvent: (event) => {
				events.push(event);
			},
		});

		try {
			await observer.start();

			await waitFor(
				() =>
					sockets.length === 1 &&
					receivedFrames.some(
						(frame) =>
							frame.kind === "stream.subscribe" &&
							frame.sessionId === "matching-session" &&
							frame.sinceSequence === 41,
					),
			);

			sockets[0].send(
				JSON.stringify({
					kind: "event",
					envelope: {
						event: "run.started",
						sessionId: "matching-session",
						sequence: 50,
					},
				}),
			);

			await waitFor(() => events.length === 1);
			expect(events).toEqual(["run.started"]);

			sockets[0].close();

			await waitFor(() => sockets.length >= 2, 2_000);

			await waitFor(
				() =>
					receivedFrames.filter(
						(frame) => frame.kind === "stream.subscribe" && frame.sessionId === "matching-session",
					).length >= 2,
				2_000,
			);

			const subscriptions = receivedFrames.filter(
				(frame) => frame.kind === "stream.subscribe" && frame.sessionId === "matching-session",
			);

			expect(subscriptions.at(-1)).toMatchObject({
				kind: "stream.subscribe",
				sessionId: "matching-session",
				sinceSequence: 50,
			});

			sockets.at(-1)?.send(
				JSON.stringify({
					kind: "event",
					envelope: {
						event: "run.completed",
						sessionId: "matching-session",
						sequence: 51,
					},
				}),
			);

			await waitFor(() => events.length === 2);
			expect(events).toEqual(["run.started", "run.completed"]);
		} finally {
			await observer.dispose();
		}
	});

	it("keeps looking when the Cline session is not found during initial startup", async () => {
		const root = mkdtempSync(join(tmpdir(), "kanban-cline-hub-late-session-"));
		tempRoots.push(root);

		const cwd = join(root, "worktree");
		mkdirSync(cwd, { recursive: true });

		const { server, url } = await startHub();
		const discoveryPath = join(root, "production.json");
		writeFileSync(discoveryPath, JSON.stringify({ url }), "utf8");

		let now = 1_000;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		const preparedAt = now;

		const receivedFrames: Record<string, unknown>[] = [];
		let sessionListCalls = 0;

		server.on("connection", (socket) => {
			socket.on("message", (raw) => {
				const parsed: unknown = JSON.parse(String(raw));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					return;
				}

				const frame = parsed as Record<string, unknown>;
				receivedFrames.push(frame);

				if (frame.kind !== "command") {
					return;
				}

				const envelope = frame.envelope;
				if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
					return;
				}

				const request = envelope as Record<string, unknown>;
				const requestId = request.requestId;
				const command = request.command;

				if (typeof requestId !== "string" || typeof command !== "string") {
					return;
				}

				let payload: Record<string, unknown> = {};

				if (command === "hub.status") {
					payload = {
						eventLog: {
							lastSequence: 7,
						},
					};
				} else if (command === "session.list") {
					sessionListCalls += 1;

					if (sessionListCalls === 1) {
						// Make the initial discovery window expire immediately
						// after this first unsuccessful lookup.
						now = 12_000;
						payload = { sessions: [] };
					} else {
						payload = {
							sessions: [
								{
									sessionId: "late-session",
									cwd,
									workspaceRoot: cwd,
									createdAt: preparedAt + 10,
									metadata: { source: "cli" },
								},
							],
						};
					}
				}

				socket.send(
					JSON.stringify({
						kind: "reply",
						envelope: {
							requestId,
							ok: true,
							payload,
						},
					}),
				);
			});
		});

		const observer = await createClineCliHubObserver({
			cwd,
			env: {
				CLINE_HUB_DISCOVERY_PATH: discoveryPath,
			},
			preparedAt,
			onRunEvent: vi.fn(),
		});

		try {
			await observer.start();
			nowSpy.mockRestore();

			await waitFor(
				() =>
					receivedFrames.some((frame) => frame.kind === "stream.subscribe" && frame.sessionId === "late-session"),
				1_000,
			);

			expect(sessionListCalls).toBeGreaterThanOrEqual(2);

			const subscribe = receivedFrames.find(
				(frame) => frame.kind === "stream.subscribe" && frame.sessionId === "late-session",
			);

			expect(subscribe).toMatchObject({
				kind: "stream.subscribe",
				sessionId: "late-session",
				sinceSequence: 7,
			});
		} finally {
			await observer.dispose();
			nowSpy.mockRestore();
		}
	});
});
