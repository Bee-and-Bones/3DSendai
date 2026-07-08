// U12 (plan-004): real STT backend behind the existing Stt seam. Buffers
// 16kHz PCM as it's fed and, on finalize(), wraps it in a WAV and runs local
// `whisper-cli` once (record-then-transcribe, KTD4) — nothing leaves the
// machine. Selected by env (SENDAI_STT=whisper) and default-off so CI/tests
// use FakeStt and never need a model (KTD5).
//
// The CLI runs via Bun.spawnSync because Stt.finalize() is synchronous by
// contract; for a sub-second..2s utterance decode that's an acceptable stall
// on this single-purpose host. (A whisper-server HTTP variant would need an
// async seam — deferred with streaming STT.)

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WHISPER_SAMPLE_RATE } from "./resample.ts";
import { FakeStt, type Stt } from "./stt.ts";

export interface WhisperSttOptions {
	/** whisper-cli binary (default "whisper-cli", resolved via PATH). */
	bin?: string;
	/** ggml model path (e.g. ggml-base.en.bin). Required to transcribe. */
	model?: string;
}

/** Build a 16-bit mono PCM WAV file image. Pure — unit-tested. */
export function wavFromPcm16(pcm: Int16Array, sampleRate: number): Uint8Array {
	const dataBytes = pcm.length * 2;
	const out = new Uint8Array(44 + dataBytes);
	const v = new DataView(out.buffer);
	const ascii = (off: number, s: string) => {
		for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
	};
	ascii(0, "RIFF");
	v.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	v.setUint32(16, 16, true); // fmt chunk size
	v.setUint16(20, 1, true); // PCM
	v.setUint16(22, 1, true); // mono
	v.setUint32(24, sampleRate, true);
	v.setUint32(28, sampleRate * 2, true); // byte rate
	v.setUint16(32, 2, true); // block align
	v.setUint16(34, 16, true); // bits/sample
	ascii(36, "data");
	v.setUint32(40, dataBytes, true);
	for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i]!, true);
	return out;
}

export class WhisperStt implements Stt {
	private readonly bin: string;
	private readonly model: string | undefined;
	private chunks: Int16Array[] = [];

	constructor(opts: WhisperSttOptions = {}) {
		this.bin = opts.bin ?? "whisper-cli";
		this.model = opts.model;
	}

	feed(pcm: Int16Array): void {
		if (pcm.length > 0) this.chunks.push(pcm.slice());
	}

	/** Record-then-transcribe (KTD4): no interim results. */
	partials(): string {
		return "";
	}

	finalize(): string {
		const total = this.chunks.reduce((n, c) => n + c.length, 0);
		const pcm = new Int16Array(total);
		let off = 0;
		for (const c of this.chunks) {
			pcm.set(c, off);
			off += c.length;
		}
		this.chunks = [];
		if (pcm.length === 0) return "";
		if (!this.model) throw new Error("WhisperStt: no model configured (SENDAI_WHISPER_MODEL)");

		const dir = mkdtempSync(join(tmpdir(), "3dsendai-stt-"));
		const wavPath = join(dir, "utterance.wav");
		try {
			writeFileSync(wavPath, wavFromPcm16(pcm, WHISPER_SAMPLE_RATE));
			const proc = Bun.spawnSync(
				[this.bin, "-m", this.model, "-f", wavPath, "--no-timestamps", "--no-prints"],
				{ stdout: "pipe", stderr: "pipe" },
			);
			if (proc.exitCode !== 0) {
				const err = new TextDecoder().decode(proc.stderr).trim();
				throw new Error(`whisper-cli exited ${proc.exitCode}: ${err.slice(0, 200)}`);
			}
			return new TextDecoder().decode(proc.stdout).replace(/\s+/g, " ").trim();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	reset(): void {
		this.chunks = [];
	}
}

/**
 * Env-selected backend (KTD5): SENDAI_STT=whisper -> the real backend
 * (SENDAI_WHISPER_BIN / SENDAI_WHISPER_MODEL); anything else -> a FakeStt
 * with an empty script, so voice degrades to no-injection without a model.
 */
export function sttFromEnv(env: Record<string, string | undefined>): Stt {
	if ((env.SENDAI_STT ?? "").toLowerCase() === "whisper") {
		return new WhisperStt({ bin: env.SENDAI_WHISPER_BIN, model: env.SENDAI_WHISPER_MODEL });
	}
	return new FakeStt("");
}
