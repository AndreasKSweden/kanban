import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { evaluateCors, evaluateHost, handleSocketUpgrade } from "../../../src/server/middleware";

const ALLOWED_ORIGIN = "http://127.0.0.1:3484";
const ALLOWED_HOSTS = new Set(["localhost:3484", "127.0.0.1:3484"]);

function makeFakeRequest(headers: Partial<IncomingMessage["headers"]>, method = "GET"): IncomingMessage {
	return { method, headers } as IncomingMessage;
}

describe("evaluateCors", () => {
	it("allows requests with no Origin header", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: undefined,
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "allow", origin: null });
	});

	it("allows requests with an empty Origin header", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: "",
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "allow", origin: null });
	});

	it("allows requests whose Origin matches the runtime origin", () => {
		const decision = evaluateCors({
			method: "POST",
			originHeader: ALLOWED_ORIGIN,
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "allow", origin: ALLOWED_ORIGIN });
	});

	it("allows an IP origin on the runtime port for wildcard bindings", () => {
		const decision = evaluateCors({
			method: "POST",
			originHeader: "http://100.85.223.22:3484",
			allowedOrigin: "http://0.0.0.0:3484",
			allowIpOriginsOnPort: 3484,
		});
		expect(decision).toEqual({ kind: "allow", origin: "http://100.85.223.22:3484" });
	});

	it("still rejects DNS origins when wildcard IP access is enabled", () => {
		const decision = evaluateCors({
			method: "POST",
			originHeader: "http://attacker.example.com:3484",
			allowedOrigin: "http://0.0.0.0:3484",
			allowIpOriginsOnPort: 3484,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://attacker.example.com:3484" });
	});

	it("rejects an IP origin on a different port for wildcard bindings", () => {
		const decision = evaluateCors({
			method: "POST",
			originHeader: "http://100.85.223.22:9999",
			allowedOrigin: "http://0.0.0.0:3484",
			allowIpOriginsOnPort: 3484,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://100.85.223.22:9999" });
	});

	it("rejects requests from a different origin", () => {
		const decision = evaluateCors({
			method: "POST",
			originHeader: "http://evil.example.com",
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://evil.example.com" });
	});

	it("rejects requests from the same host but a different port", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: "http://127.0.0.1:9999",
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://127.0.0.1:9999" });
	});

	it("rejects requests from the same host but a different scheme", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: "https://127.0.0.1:3484",
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "reject", origin: "https://127.0.0.1:3484" });
	});

	it("returns a preflight decision for OPTIONS from the allowed origin", () => {
		const decision = evaluateCors({
			method: "OPTIONS",
			originHeader: ALLOWED_ORIGIN,
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "preflight", origin: ALLOWED_ORIGIN });
	});

	it("rejects preflight from a disallowed origin", () => {
		const decision = evaluateCors({
			method: "OPTIONS",
			originHeader: "http://evil.example.com",
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://evil.example.com" });
	});

	it("allows OPTIONS without an Origin header (not a CORS preflight)", () => {
		const decision = evaluateCors({
			method: "OPTIONS",
			originHeader: undefined,
			allowedOrigin: ALLOWED_ORIGIN,
		});
		expect(decision).toEqual({ kind: "allow", origin: null });
	});
});

describe("evaluateHost", () => {
	it("rejects requests with no Host header", () => {
		expect(evaluateHost({ hostHeader: undefined, allowedHosts: ALLOWED_HOSTS })).toEqual({
			kind: "reject",
			host: null,
		});
	});

	it("rejects requests with an empty Host header", () => {
		expect(evaluateHost({ hostHeader: "", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "reject", host: null });
	});

	it("allows requests whose Host is in the allowlist", () => {
		expect(evaluateHost({ hostHeader: "127.0.0.1:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "allow" });
		expect(evaluateHost({ hostHeader: "localhost:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "allow" });
	});

	it("normalises Host header casing before comparing", () => {
		expect(evaluateHost({ hostHeader: "LocalHost:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "allow" });
	});

	it("allows an IP Host on the runtime port for wildcard bindings", () => {
		expect(
			evaluateHost({
				hostHeader: "100.85.223.22:3484",
				allowedHosts: new Set(["0.0.0.0:3484"]),
				allowIpHostsOnPort: 3484,
			}),
		).toEqual({ kind: "allow" });
	});

	it("still rejects DNS Host headers when wildcard IP access is enabled", () => {
		expect(
			evaluateHost({
				hostHeader: "attacker.example.com:3484",
				allowedHosts: new Set(["0.0.0.0:3484"]),
				allowIpHostsOnPort: 3484,
			}),
		).toEqual({ kind: "reject", host: "attacker.example.com:3484" });
	});

	it("rejects an IP Host on a different port for wildcard bindings", () => {
		expect(
			evaluateHost({
				hostHeader: "100.85.223.22:9999",
				allowedHosts: new Set(["0.0.0.0:3484"]),
				allowIpHostsOnPort: 3484,
			}),
		).toEqual({ kind: "reject", host: "100.85.223.22:9999" });
	});

	it("rejects DNS rebinding attempts via a foreign Host header", () => {
		expect(evaluateHost({ hostHeader: "attacker.example.com:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({
			kind: "reject",
			host: "attacker.example.com:3484",
		});
	});

	it("rejects when the port doesn't match", () => {
		expect(evaluateHost({ hostHeader: "localhost:9999", allowedHosts: ALLOWED_HOSTS })).toEqual({
			kind: "reject",
			host: "localhost:9999",
		});
	});
});

describe("handleSocketUpgrade", () => {
	it("passes through upgrades whose Host and Origin are both allowed", () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({ host: "127.0.0.1:3484", origin: ALLOWED_ORIGIN });
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: false });
		expect(socket.destroyed).toBe(false);
	});

	it("rejects upgrades from a disallowed origin with a 403 status line", () => {
		const socket = new PassThrough();
		const written: Buffer[] = [];
		socket.on("data", (chunk) => {
			written.push(chunk as Buffer);
		});
		const request = makeFakeRequest({ host: "127.0.0.1:3484", origin: "http://evil.example.com" });
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: true });
		expect(socket.destroyed).toBe(true);
		expect(Buffer.concat(written).toString("utf8")).toContain("HTTP/1.1 403 Forbidden");
	});

	it("rejects upgrades whose Host header doesn't match the allowlist", () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({ host: "attacker.example.com:3484", origin: ALLOWED_ORIGIN });
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: true });
		expect(socket.destroyed).toBe(true);
	});

	it("rejects upgrades with a missing Host header", () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({});
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: true });
		expect(socket.destroyed).toBe(true);
	});
});
