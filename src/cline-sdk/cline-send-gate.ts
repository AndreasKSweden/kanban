// Final output is not SDK readiness: send() settles after the SessionRuntime
// drains and releases its run. Reserve continuations synchronously so multiple
// callers cannot all pass the same readiness check.
export class ClineSendGate {
	private tail: Promise<void> | null = null;
	private cancellation = new AbortController();

	constructor(private readonly timeoutMs = 60_000) {}

	run<T>(send: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		const signal = this.cancellation.signal;
		const operation = (async () => {
			if (previous) await this.wait(previous, signal);
			else await Promise.resolve(); // Install the reservation before send can emit callbacks.
			signal.throwIfAborted();
			return await send();
		})();
		// A timed-out/cancelled waiter must not release the preceding run's
		// reservation. Observe errors here only for bookkeeping; operation still
		// rejects to the caller and its normal task-error reporting path.
		const settled = operation.then(
			() => {},
			() => {},
		);
		const tail = Promise.all([previous, settled]).then(() => {});
		this.tail = tail;
		void tail.then(() => {
			if (this.tail === tail) this.tail = null;
		});
		return operation;
	}

	cancel(): void {
		this.cancellation.abort(new Error("Cline continuation cancelled before the session became ready."));
		this.cancellation = new AbortController();
	}

	private wait(previous: Promise<void>, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const finish = (error?: Error) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve();
			};
			const onAbort = () => finish(signal.reason);
			const timer = setTimeout(
				() =>
					finish(
						new Error(
							"Timed out waiting for the previous Cline send to finish. Cancel the active turn before retrying.",
						),
					),
				this.timeoutMs,
			);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			void previous.then(() => finish());
		});
	}
}
