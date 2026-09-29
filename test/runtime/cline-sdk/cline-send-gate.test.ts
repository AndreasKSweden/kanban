import { afterEach, describe, expect, it, vi } from "vitest";
import { ClineSendGate } from "../../../src/cline-sdk/cline-send-gate";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe("Cline continuation readiness", () => {
	it("serializes several review/correction iterations after final output but before run settlement", async () => {
		const gate = new ClineSendGate();
		let running = false;
		const starts: number[] = [];
		for (let iteration = 0; iteration < 3; iteration++) {
			const drained = deferred();
			const implementation = gate.run(async () => {
				expect(running).toBe(false);
				running = true;
				await drained.promise;
				running = false;
			});
			// Final output has arrived; the runtime is still running until drained.
			const review = gate.run(async () => {
				expect(running).toBe(false);
				starts.push(iteration);
			});
			await Promise.resolve();
			expect(starts).toHaveLength(iteration);
			drained.resolve();
			await Promise.all([implementation, review]);
			expect(starts).toEqual(Array.from({ length: iteration + 1 }, (_, i) => i));
		}
	});

	it("reserves concurrent continuations exactly once", async () => {
		const gate = new ClineSendGate();
		const drained = deferred();
		const first = gate.run(() => drained.promise);
		const order: number[] = [];
		const next = [1, 2, 3].map((i) =>
			gate.run(async () => {
				order.push(i);
			}),
		);
		expect(order).toEqual([]);
		drained.resolve();
		await Promise.all([first, ...next]);
		expect(order).toEqual([1, 2, 3]);
	});

	it("cancels waiting sends without starting them when the preceding run finally drains", async () => {
		const gate = new ClineSendGate();
		const drained = deferred();
		const first = gate.run(() => drained.promise);
		await Promise.resolve();
		const send = vi.fn(async () => {});
		const next = gate.run(send);
		gate.cancel();
		await expect(next).rejects.toThrow("cancelled");
		drained.resolve();
		await first;
		expect(send).not.toHaveBeenCalled();
	});

	it("bounds waiting without releasing a still-running predecessor or sending late", async () => {
		vi.useFakeTimers();
		const gate = new ClineSendGate(100);
		const drained = deferred();
		const first = gate.run(() => drained.promise);
		const send = vi.fn(async () => {});
		const next = expect(gate.run(send)).rejects.toThrow("Timed out");
		await vi.advanceTimersByTimeAsync(100);
		await next;
		const retry = expect(gate.run(send)).rejects.toThrow("Timed out");
		await vi.advanceTimersByTimeAsync(100);
		await retry;
		drained.resolve();
		await first;
		await vi.runAllTimersAsync();
		expect(send).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reserves the run before synchronous output callbacks can request continuation", async () => {
		const gate = new ClineSendGate();
		const drained = deferred();
		const send = vi.fn(async () => {});
		let next: Promise<void> | undefined;
		const first = gate.run(async () => {
			next = gate.run(send);
			await drained.promise;
		});
		await Promise.resolve();
		expect(send).not.toHaveBeenCalled();
		drained.resolve();
		await first;
		await next;
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("reports abnormal termination and allows a later continuation after settlement", async () => {
		const gate = new ClineSendGate();
		const failed = gate.run(async () => {
			throw new Error("previous run failed");
		});
		await expect(failed).rejects.toThrow("previous run failed");
		await expect(gate.run(async () => "recovered")).resolves.toBe("recovered");
	});
});
