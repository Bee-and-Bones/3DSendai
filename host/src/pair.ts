// U5 (plan-004): `pair` mode — mint a PSK and print a scannable terminal QR of
// the pairing URI, plus the PSK hex as a manual fallback. The QR carries the
// secret out-of-band (KTD2): the device scans it, persists it to SD (U7), and
// then uses the existing encrypted discovery + connect path unchanged.
//
// URI grammar (shared fixture with the device parser in client/source/paircfg.c):
//   3dsendai://<psk64hex>[@<host>:<port>][?token=<token>]
// Host/port are optional — when omitted the device relies on encrypted UDP
// discovery to find the host.

import { mintPsk, keyToHex } from "./psk.ts";
import { qrEncode, qrToTerminal } from "./qr.ts";

export interface PairInfo {
  psk: string; // 64 lowercase hex chars
  host?: string;
  port?: number;
  token?: string;
}

const SCHEME = "3dsendai://";

/** Compose the pairing URI. */
export function composePairUri(info: PairInfo): string {
  let uri = SCHEME + info.psk;
  if (info.host) uri += `@${info.host}:${info.port ?? 4791}`;
  if (info.token) uri += `?token=${info.token}`;
  return uri;
}

/** Parse a pairing URI. Null on any malformation (mirrors the C parser). */
export function parsePairUri(uri: string): PairInfo | null {
  if (!uri.startsWith(SCHEME)) return null;
  let rest = uri.slice(SCHEME.length);
  let token: string | undefined;
  const q = rest.indexOf("?");
  if (q !== -1) {
    const query = rest.slice(q + 1);
    rest = rest.slice(0, q);
    if (!query.startsWith("token=") || query.length === 6) return null;
    token = query.slice(6);
  }
  let host: string | undefined;
  let port: number | undefined;
  const at = rest.indexOf("@");
  if (at !== -1) {
    const hostPort = rest.slice(at + 1);
    rest = rest.slice(0, at);
    const colon = hostPort.lastIndexOf(":");
    if (colon <= 0) return null;
    host = hostPort.slice(0, colon);
    port = Number(hostPort.slice(colon + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }
  const psk = rest.toLowerCase();
  if (psk.length !== 64 || !/^[0-9a-f]{64}$/.test(psk)) return null;
  return { psk, host, port, token };
}

export interface PairModeOptions {
  host?: string;
  port?: number;
  token?: string;
  print?: (line: string) => void;
}

/** Run pair mode: mint, render, and return the info for the caller/host. */
export function runPairMode(opts: PairModeOptions = {}): PairInfo {
  const print = opts.print ?? console.log;
  const info: PairInfo = {
    psk: keyToHex(mintPsk()),
    host: opts.host,
    port: opts.host ? opts.port ?? 4791 : undefined,
    token: opts.token,
  };
  const uri = composePairUri(info);
  print("3DSendai pairing — scan with the device's camera (pair screen):");
  print("");
  print(qrToTerminal(qrEncode(uri)));
  print("");
  print(`  uri: ${uri}`);
  print(`  psk (manual fallback / SENDAI_PSK): ${info.psk}`);
  if (!info.host) print("  no host in URI: the device will find this host via encrypted discovery");
  print("");
  print(`start the host with: SENDAI_PSK=${info.psk} ${info.token ? `SENDAI_TOKEN=${info.token} ` : ""}...`);
  return info;
}
