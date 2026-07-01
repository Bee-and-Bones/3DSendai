// Sample-rate conversion for the audio ingest path (U14, finding #16).
//
// The 3DS mic (MICU_SAMPLE_RATE_16360) captures at 16364.479 Hz, NOT 16000 Hz.
// whisper requires exactly 16000 Hz input, so the host resamples every captured
// chunk before feeding STT. This module is the pure, unit-testable core of that.

/** Actual 3DS capture rate (MICU_SAMPLE_RATE_16360). */
export const DEVICE_SAMPLE_RATE = 16364.479;

/** Rate whisper requires. */
export const WHISPER_SAMPLE_RATE = 16000;

/**
 * Linear-interpolation resampler. Output length is
 * round(input.length * toRate / fromRate). Empty input yields empty output, and
 * when fromRate === toRate the input is returned unchanged (identity). Every
 * output sample is a finite Int16 value (no NaN/Infinity).
 */
export function resampleLinear(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (input.length === 0) return new Int16Array(0);
  if (fromRate === toRate) return input.slice();

  const ratio = toRate / fromRate;
  const outLength = Math.round(input.length * ratio);
  if (outLength <= 0) return new Int16Array(0);

  const out = new Int16Array(outLength);
  const lastIndex = input.length - 1;

  for (let i = 0; i < outLength; i++) {
    // Position in the input signal that this output sample maps to.
    const pos = i / ratio;
    const left = Math.floor(pos);
    const frac = pos - left;

    if (left >= lastIndex) {
      out[i] = input[lastIndex] as number;
      continue;
    }

    const a = input[left] as number;
    const b = input[left + 1] as number;
    out[i] = Math.round(a + (b - a) * frac);
  }

  return out;
}
