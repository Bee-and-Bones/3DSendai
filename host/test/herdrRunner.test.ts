// F3 (review) regression: the control-channel stdout pump must contain a
// reader/pipe error as a channel-closed (onExit) event instead of letting the
// promise rejection escape and crash the whole host process. Hermetic — drives
// the exported pump with a fake ReadableStream, no live herdr child.

import { describe, expect, test } from "bun:test";
import { pumpControlStdout } from "../src/herdr/runner.ts";

describe("pumpControlStdout (F3)", () => {
	test("a reader error ends the channel via onExit and is contained (no unhandled rejection)", async () => {
		let exited = false;
		let dataCalls = 0;
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.error(new Error("pipe broke"));
				},
			});
			pumpControlStdout(
				stream,
				() => () => {
					dataCalls += 1;
				},
				() => () => {
					exited = true;
				},
			);
			await Bun.sleep(5);
			expect(exited).toBe(true); // the reader error surfaced as channel-closed
			expect(dataCalls).toBe(0);
			expect(unhandled.length).toBe(0); // the rejection did not escape to the process
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("stdout chunks reach onData until EOF; a clean EOF does not fire onExit", async () => {
		const chunks: string[] = [];
		const dec = new TextDecoder();
		const enc = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(enc.encode("hello "));
				controller.enqueue(enc.encode("world"));
				controller.close();
			},
		});
		let exited = false;
		pumpControlStdout(
			stream,
			() => (b) => chunks.push(dec.decode(b)),
			() => () => {
				exited = true;
			},
		);
		await Bun.sleep(5);
		expect(chunks.join("")).toBe("hello world");
		// A normal EOF resolves the pump cleanly; onExit is the child.exited seam's
		// responsibility, not the pump's, so the pump must NOT fire it here.
		expect(exited).toBe(false);
	});
});
