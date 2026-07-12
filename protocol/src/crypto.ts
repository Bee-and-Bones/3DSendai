// XChaCha20-Poly1305 AEAD wrapper (host side), U23.
//
// Thin shim over libsodium's IETF XChaCha20-Poly1305. The C client uses
// Monocypher's crypto_aead_lock/unlock over the same algorithm; a shared
// known-answer test (protocol/test/crypto.test.ts + client/test/crypto_test.c)
// keeps the two byte-identical.
//
// libsodium APPENDS the 16-byte MAC to the ciphertext. The 3Base wire
// (which 3dsendai adopts) carries nonce ‖ ciphertext ‖ mac as separate fields;
// the split/join lives in secureFrame.ts, so this module speaks libsodium's
// native "sealed = ciphertext‖mac" shape.

import _sodium from "libsodium-wrappers";
import { KEY_BYTES, MAC_BYTES, NONCE_BYTES } from "./crypto-constants.generated.ts";

// libsodium's WASM initializes asynchronously; await once before any call.
let sodium: typeof _sodium | null = null;

export async function cryptoReady(): Promise<void> {
	if (sodium) return;
	await _sodium.ready;
	sodium = _sodium;
}

function requireReady(): typeof _sodium {
	if (!sodium) throw new Error("crypto not ready: await cryptoReady() first");
	return sodium;
}

function assertKeyNonce(key: Uint8Array, nonce: Uint8Array): void {
	if (key.length !== KEY_BYTES)
		throw new RangeError(`key must be ${KEY_BYTES} bytes, got ${key.length}`);
	if (nonce.length !== NONCE_BYTES)
		throw new RangeError(`nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`);
}

/** Seal plaintext -> ciphertext‖mac (libsodium's appended-MAC layout). */
export function encrypt(
	key: Uint8Array,
	nonce: Uint8Array,
	aad: Uint8Array,
	plaintext: Uint8Array,
): Uint8Array {
	assertKeyNonce(key, nonce);
	const s = requireReady();
	return s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key);
}

/** Open ciphertext‖mac. Returns null on any authentication failure. */
export function decrypt(
	key: Uint8Array,
	nonce: Uint8Array,
	aad: Uint8Array,
	sealed: Uint8Array,
): Uint8Array | null {
	assertKeyNonce(key, nonce);
	if (sealed.length < MAC_BYTES) return null;
	const s = requireReady();
	try {
		return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, sealed, aad, nonce, key);
	} catch {
		return null;
	}
}
