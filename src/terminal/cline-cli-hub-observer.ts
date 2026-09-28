import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { WebSocket } from "ws";

export type ClineCliHubRunEvent = "run.started" | "run.completed" | "run.failed" | "run.aborted";

interface ClineCliHubObserverOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	preparedAt: number;
	onRunEvent: (event: ClineCliHubRunEvent) => void | Promise<void>;
}

export interface ClineCliHubObserver {
	start(): Promise<void>;
	dispose(): Promise<void>;
}

interface HubDiscovery {
	url: string;
	authToken?: string;
}

interface HubReplyEnvelope {
	requestId?: string;
	ok?: boolean;
	payload?: Record<string, unknown>;
	error?: {
		code?: string;
		message?: string;
	};
}

interface HubEventEnvelope {
	event?: string;
	sessionId?: string;
	sequence?: number;
}

interface PendingReply {
	resolve: (reply: HubReplyEnvelope) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const HUB_COMMAND_TIMEOUT_MS = 3_000;
const HUB_DISCOVERY_TIMEOUT_MS = 8_000;
const SESSION_DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_POLL_MS = 100;
const SESSION_POLL_MS = 100;

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveDiscoveryPath(env?: Record<string, string | undefined>): string {
	const explicit = env?.CLINE_HUB_DISCOVERY_PATH?.trim() || process.env.CLINE_HUB_DISCOVERY_PATH?.trim();
	if (explicit) {
		return explicit;
	}

	const home = env?.HOME?.trim() || process.env.HOME?.trim() || homedir();
	return join(home, ".cline", "data", "locks", "hub", "production.json");
}

async function readDiscovery(path: string): Promise<HubDiscovery | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isRecord(parsed)) {
			return null;
		}
		const url = optionalString(parsed.url);
		if (!url) {
			return null;
		}
		return {
			url,
			authToken: optionalString(parsed.authToken),
		};
	} catch {
		return null;
	}
}

class Observer implements ClineCliHubObserver {
	private readonly targetCwd: string;
	private readonly discoveryPath: string;
	private readonly clientId: string;
	private socket: WebSocket | null = null;
	private readonly pendingReplies = new Map<string, PendingReply>();
	private requestCounter = 0;
	private sessionId: string | null = null;
	private eventSequence = 0;
	private disposed = false;
	private started = false;
	private reconnectPromise: Promise<void> | null = null;
	private runEventDelivery: Promise<void> = Promise.resolve();

	constructor(private readonly options: ClineCliHubObserverOptions) {
		this.targetCwd = resolve(options.cwd);
		this.discoveryPath = resolveDiscoveryPath(options.env);
		this.clientId = `kanban-cline-cli-${process.pid}-${randomUUID()}`;
	}

	async capturePreLaunchCursor(): Promise<void> {
		try {
			await this.ensureConnected(false);
			const reply = await this.command("hub.status", {});
			const eventLog = isRecord(reply.payload?.eventLog) ? reply.payload.eventLog : undefined;
			this.eventSequence = optionalNumber(eventLog?.lastSequence) ?? 0;
		} catch {
			this.closeSocket();
			this.eventSequence = 0;
		}
	}

	async start(): Promise<void> {
		if (this.disposed) {
			return;
		}

		this.started = true;

		try {
			await this.ensureConnected(true);

			if (this.disposed || !this.started) {
				return;
			}

			if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
				this.scheduleReconnect();
				return;
			}

			const sessionId = await this.findMatchingSession();

			if (this.disposed || !this.started) {
				return;
			}

			if (!sessionId) {
				this.scheduleReconnect();
				return;
			}

			this.sessionId = sessionId;
			this.subscribeToSession(sessionId);
		} catch {
			if (this.started && !this.disposed) {
				this.scheduleReconnect();
			}
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.started = false;

		if (this.socket?.readyState === WebSocket.OPEN) {
			if (this.sessionId) {
				try {
					this.sendFrame({
						kind: "stream.unsubscribe",
						clientId: this.clientId,
						sessionId: this.sessionId,
					});
				} catch {
					// Best effort only.
				}
			}
			try {
				await this.command("client.unregister", {});
			} catch {
				// Best effort only.
			}
		}

		this.closeSocket();
	}

	private async ensureConnected(retryDiscovery: boolean): Promise<void> {
		if (this.socket?.readyState === WebSocket.OPEN) {
			return;
		}

		const deadline = Date.now() + (retryDiscovery ? HUB_DISCOVERY_TIMEOUT_MS : 0);

		for (;;) {
			if (this.disposed) {
				return;
			}

			const discovery = await readDiscovery(this.discoveryPath);
			if (discovery) {
				try {
					await this.connect(discovery);
					return;
				} catch {
					this.closeSocket();
				}
			}

			if (!retryDiscovery || Date.now() >= deadline) {
				throw new Error("Cline Hub discovery is unavailable");
			}
			await sleep(DISCOVERY_POLL_MS);
		}
	}

	private async connect(discovery: HubDiscovery): Promise<void> {
		const protocols = discovery.authToken ? [`cline-hub-auth.${discovery.authToken}`] : undefined;
		const socket = new WebSocket(discovery.url, protocols);
		this.socket = socket;

		socket.on("message", (raw) => {
			this.handleFrame(String(raw));
		});
		socket.on("close", () => {
			if (this.socket === socket) {
				this.rejectPending(new Error("Cline Hub connection closed"));
				this.socket = null;
				if (this.started && !this.disposed) {
					this.scheduleReconnect();
				}
			}
		});
		socket.on("error", () => {
			// Connection errors are surfaced by the open promise or close event.
		});

		await new Promise<void>((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				rejectPromise(new Error("Timed out connecting to Cline Hub"));
				try {
					socket.close();
				} catch {
					// Best effort only.
				}
			}, HUB_COMMAND_TIMEOUT_MS);

			socket.once("open", () => {
				clearTimeout(timer);
				resolvePromise();
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				rejectPromise(error instanceof Error ? error : new Error(String(error)));
			});
		});

		await this.command("client.register", {
			clientId: this.clientId,
			clientType: "kanban-cline-cli",
			displayName: "Kanban Cline CLI observer",
			transport: "native",
			actorKind: "client",
			capabilities: [],
			workspaceContext: {
				workspaceRoot: this.targetCwd,
				cwd: this.targetCwd,
			},
		});
	}

	private subscribeToSession(sessionId: string): void {
		this.sendFrame({
			kind: "stream.subscribe",
			clientId: this.clientId,
			sessionId,
			sinceSequence: this.eventSequence,
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectPromise || this.disposed || !this.started) {
			return;
		}

		this.reconnectPromise = this.reconnectLoop()
			.catch(() => {
				// Best effort. The reconnect loop handles transient failures.
			})
			.finally(() => {
				this.reconnectPromise = null;
			});
	}

	private async reconnectLoop(): Promise<void> {
		while (!this.disposed && this.started) {
			try {
				await this.ensureConnected(true);

				if (this.disposed || !this.started || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
					return;
				}

				const sessionId = await this.findMatchingSession();
				if (!sessionId) {
					await sleep(DISCOVERY_POLL_MS);
					continue;
				}

				this.sessionId = sessionId;
				this.subscribeToSession(sessionId);
				return;
			} catch {
				if (this.disposed || !this.started) {
					return;
				}
				await sleep(DISCOVERY_POLL_MS);
			}
		}
	}

	private async findMatchingSession(): Promise<string | null> {
		const deadline = Date.now() + SESSION_DISCOVERY_TIMEOUT_MS;

		while (!this.disposed && Date.now() < deadline) {
			const reply = await this.command("session.list", { limit: 100 });
			const sessions = Array.isArray(reply.payload?.sessions) ? reply.payload.sessions : [];

			const matches = sessions
				.filter(isRecord)
				.flatMap((session) => {
					const sessionId = optionalString(session.sessionId);
					const cwd = optionalString(session.cwd);
					const workspaceRoot = optionalString(session.workspaceRoot);
					const createdAt = optionalNumber(session.createdAt);
					const metadata = isRecord(session.metadata) ? session.metadata : undefined;
					const source = optionalString(metadata?.source);

					if (
						!sessionId ||
						!cwd ||
						!workspaceRoot ||
						createdAt === undefined ||
						resolve(cwd) !== this.targetCwd ||
						resolve(workspaceRoot) !== this.targetCwd ||
						createdAt < this.options.preparedAt ||
						source !== "cli"
					) {
						return [];
					}

					return [{ sessionId, createdAt }];
				})
				.sort((left, right) => right.createdAt - left.createdAt);

			if (this.sessionId) {
				const previousSession = matches.find((match) => match.sessionId === this.sessionId);
				if (previousSession) {
					return previousSession.sessionId;
				}
			}

			if (matches[0]) {
				return matches[0].sessionId;
			}

			await sleep(SESSION_POLL_MS);
		}

		return null;
	}

	private command(command: string, payload: Record<string, unknown>): Promise<HubReplyEnvelope> {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("Cline Hub connection is not open"));
		}

		const requestId = `kanban-${++this.requestCounter}-${Date.now().toString(36)}`;

		return new Promise<HubReplyEnvelope>((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				this.pendingReplies.delete(requestId);
				rejectPromise(new Error(`Cline Hub command timed out: ${command}`));
			}, HUB_COMMAND_TIMEOUT_MS);

			this.pendingReplies.set(requestId, {
				resolve: resolvePromise,
				reject: rejectPromise,
				timer,
			});

			this.sendFrame({
				kind: "command",
				envelope: {
					version: "v1",
					command,
					requestId,
					clientId: this.clientId,
					payload,
				},
			});
		}).then((reply) => {
			if (!reply.ok) {
				throw new Error(reply.error?.message ?? `Cline Hub command failed: ${command}`);
			}
			return reply;
		});
	}

	private sendFrame(frame: Record<string, unknown>): void {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			throw new Error("Cline Hub connection is not open");
		}
		socket.send(JSON.stringify(frame));
	}

	private handleFrame(raw: string): void {
		let frame: unknown;
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}
		if (!isRecord(frame)) {
			return;
		}

		if (frame.kind === "reply" && isRecord(frame.envelope)) {
			const requestId = optionalString(frame.envelope.requestId);
			if (!requestId) {
				return;
			}
			const pending = this.pendingReplies.get(requestId);
			if (!pending) {
				return;
			}
			this.pendingReplies.delete(requestId);
			clearTimeout(pending.timer);
			pending.resolve(frame.envelope as HubReplyEnvelope);
			return;
		}

		if (frame.kind !== "event" || !isRecord(frame.envelope)) {
			return;
		}

		const envelope = frame.envelope as HubEventEnvelope;
		if (typeof envelope.sequence === "number" && envelope.sequence > this.eventSequence) {
			this.eventSequence = envelope.sequence;
		}

		if (!this.sessionId || envelope.sessionId !== this.sessionId) {
			return;
		}

		switch (envelope.event) {
			case "run.started":
			case "run.completed":
			case "run.failed":
			case "run.aborted":
				this.enqueueRunEvent(envelope.event);
				break;
			default:
				break;
		}
	}

	private enqueueRunEvent(event: ClineCliHubRunEvent): void {
		this.runEventDelivery = this.runEventDelivery
			.then(() => this.options.onRunEvent(event))
			.catch(() => {
				// Best effort only. Existing Cline hooks remain as fallback signals.
			});
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pendingReplies.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pendingReplies.clear();
	}

	private closeSocket(): void {
		const socket = this.socket;
		this.socket = null;
		this.rejectPending(new Error("Cline Hub connection closed"));
		if (!socket) {
			return;
		}
		try {
			socket.close();
		} catch {
			// Best effort only.
		}
	}
}

export async function createClineCliHubObserver(options: ClineCliHubObserverOptions): Promise<ClineCliHubObserver> {
	const observer = new Observer(options);
	await observer.capturePreLaunchCursor();
	return observer;
}
