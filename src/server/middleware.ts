import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import {
	getKanbanRuntimeHost,
	getKanbanRuntimeOrigin,
	getKanbanRuntimePort,
	isKanbanRemoteHost,
} from "../core/runtime-endpoint";

export type CorsDecision =
	| { kind: "allow"; origin: string | null }
	| { kind: "preflight"; origin: string }
	| { kind: "reject"; origin: string };

export interface CorsGateInput {
	method: string | undefined;
	originHeader: string | undefined;
	allowedOrigin: string;
	allowIpOriginsOnPort?: number | null;
}

const isDev = process.env.NODE_ENV === "development";

function normalizeIpHostname(hostname: string): string {
	if (hostname.startsWith("[") && hostname.endsWith("]")) {
		return hostname.slice(1, -1);
	}
	return hostname;
}

function isIpOriginOnPort(origin: string, allowedOrigin: string, port: number): boolean {
	try {
		const parsed = new URL(origin);
		const allowed = new URL(allowedOrigin);
		const hostname = normalizeIpHostname(parsed.hostname);
		const parsedPort = parsed.port.length > 0 ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;

		return (
			isIP(hostname) !== 0 &&
			parsed.protocol === allowed.protocol &&
			parsedPort === port &&
			parsed.username === "" &&
			parsed.password === "" &&
			parsed.pathname === "/" &&
			parsed.search === "" &&
			parsed.hash === ""
		);
	} catch {
		return false;
	}
}

export function evaluateCors(input: CorsGateInput): CorsDecision {
	const origin = input.originHeader || null;
	const isPreflight = input.method === "OPTIONS";

	if (origin === null) {
		return { kind: "allow", origin: null };
	}

	const isDevServer = isDev && (origin === "http://localhost:4173" || origin === "http://127.0.0.1:4173");

	const isAllowedIpOrigin =
		input.allowIpOriginsOnPort != null && isIpOriginOnPort(origin, input.allowedOrigin, input.allowIpOriginsOnPort);

	if (origin !== input.allowedOrigin && !isDevServer && !isAllowedIpOrigin) {
		return { kind: "reject", origin };
	}

	if (isPreflight) {
		return { kind: "preflight", origin };
	}

	return { kind: "allow", origin };
}

export interface HostGateInput {
	hostHeader: string | undefined;
	allowedHosts: ReadonlySet<string>;
	allowIpHostsOnPort?: number | null;
}

export type HostDecision = { kind: "allow" } | { kind: "reject"; host: string | null };

function isIpHostOnPort(hostHeader: string, port: number): boolean {
	let hostname: string;
	let portText: string;

	if (hostHeader.startsWith("[")) {
		const match = /^\[([^\]]+)\]:(\d+)$/.exec(hostHeader);
		if (!match) {
			return false;
		}
		hostname = match[1] ?? "";
		portText = match[2] ?? "";
	} else {
		const separator = hostHeader.lastIndexOf(":");
		if (separator <= 0) {
			return false;
		}
		hostname = hostHeader.slice(0, separator);
		portText = hostHeader.slice(separator + 1);
	}

	return isIP(hostname) !== 0 && Number(portText) === port;
}

export function evaluateHost(input: HostGateInput): HostDecision {
	if (!input.hostHeader) {
		return { kind: "reject", host: null };
	}

	const normalizedHost = input.hostHeader.toLowerCase();
	const isAllowedIpHost = input.allowIpHostsOnPort != null && isIpHostOnPort(normalizedHost, input.allowIpHostsOnPort);

	if (!input.allowedHosts.has(normalizedHost) && !isAllowedIpHost) {
		return { kind: "reject", host: input.hostHeader };
	}

	return { kind: "allow" };
}

function getWildcardRuntimePort(): number | null {
	const host = getKanbanRuntimeHost().toLowerCase();
	return host === "0.0.0.0" || host === "::" || host === "[::]" ? getKanbanRuntimePort() : null;
}

export function getAllowedHostHeaders(): ReadonlySet<string> {
	const port = getKanbanRuntimePort();
	const boundHost = getKanbanRuntimeHost().toLowerCase();
	const allowed = new Set<string>();
	const addHostPort = (host: string) => {
		allowed.add(`${host}:${port}`);
	};

	if (isKanbanRemoteHost()) {
		addHostPort(boundHost);
		return allowed;
	}

	addHostPort("localhost");
	addHostPort("127.0.0.1");
	if (isDev) {
		// Vite's default dev server host:port
		allowed.add("localhost:4173");
		allowed.add("127.0.0.1:4173");
	}
	return allowed;
}

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].join(", ");
const ALLOWED_HEADERS = ["Authorization", "Content-Type", "X-Kanban-Workspace-Id"].join(", ");
const PREFLIGHT_MAX_AGE_SECONDS = "600";

function applyAllowedOriginHeaders(res: ServerResponse, origin: string): void {
	res.setHeader("Access-Control-Allow-Origin", origin);
	res.setHeader("Vary", "Origin");
	res.setHeader("Access-Control-Allow-Credentials", "true");
}

function rejectRequest(res: ServerResponse, message: string): { end: boolean } {
	res.writeHead(403, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify({ error: message }));
	return { end: true };
}

function rejectSocket(socket: Duplex): { end: boolean } {
	socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
	socket.destroy();
	return { end: true };
}

export function handleHttpRequest(req: IncomingMessage, res: ServerResponse): { end: boolean } {
	const wildcardRuntimePort = getWildcardRuntimePort();
	const hostDecision = evaluateHost({
		hostHeader: req.headers.host,
		allowedHosts: getAllowedHostHeaders(),
		allowIpHostsOnPort: wildcardRuntimePort,
	});
	if (hostDecision.kind === "reject") {
		return rejectRequest(res, "Host not allowed.");
	}

	const corsDecision = evaluateCors({
		method: req.method,
		originHeader: req.headers.origin,
		allowedOrigin: getKanbanRuntimeOrigin(),
		allowIpOriginsOnPort: wildcardRuntimePort,
	});

	switch (corsDecision.kind) {
		case "allow": {
			if (corsDecision.origin !== null) {
				applyAllowedOriginHeaders(res, corsDecision.origin);
			}
			return { end: false };
		}
		case "preflight": {
			applyAllowedOriginHeaders(res, corsDecision.origin);
			res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
			res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
			res.setHeader("Access-Control-Max-Age", PREFLIGHT_MAX_AGE_SECONDS);
			res.writeHead(204);
			res.end();
			return { end: true };
		}
		case "reject": {
			return rejectRequest(res, "Origin not allowed.");
		}
	}
}

export function handleSocketUpgrade(request: IncomingMessage, socket: Duplex): { end: boolean } {
	const wildcardRuntimePort = getWildcardRuntimePort();
	const hostDecision = evaluateHost({
		hostHeader: request.headers.host,
		allowedHosts: getAllowedHostHeaders(),
		allowIpHostsOnPort: wildcardRuntimePort,
	});
	if (hostDecision.kind === "reject") {
		return rejectSocket(socket);
	}

	const corsDecision = evaluateCors({
		method: request.method,
		originHeader: request.headers.origin,
		allowedOrigin: getKanbanRuntimeOrigin(),
		allowIpOriginsOnPort: wildcardRuntimePort,
	});
	if (corsDecision.kind === "reject") {
		return rejectSocket(socket);
	}

	return { end: false };
}
