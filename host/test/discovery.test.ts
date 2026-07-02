// UDP discovery responder tests (U27). Exercises the pure probe/reply logic
// against the golden vectors and the live Bun.udpSocket responder end-to-end
// on loopback.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  cryptoReady,
  sealRecord,
  fromHex,
  toHex,
  DIR_UP,
  AAD_DSC_CONTEXT,
  AAD_MSG_CONTEXT,
} from "@agentbus/protocol";
import { parseProbe, buildReply, startDiscoveryResponder } from "../src/server/discovery.ts";
import vectors from "../../protocol/test/golden/secure-vectors.json";

const PSK = fromHex(vectors.key_hex);
const MAGIC = new TextEncoder().encode("ag3n");
const CHALLENGE = Uint8Array.from({ length: 8 }, (_, i) => 0xa0 + i);

function datagram(type: number, record: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + record.length);
  out.set(MAGIC, 0);
  out[4] = type;
  out.set(record, 5);
  return out;
}

function goldenRecord(name: string): Uint8Array {
  const v = vectors.vectors.find((x) => x.name === name);
  if (!v) throw new Error(`missing golden vector ${name}`);
  return fromHex(v.record_hex);
}

beforeAll(async () => {
  await cryptoReady();
});

describe("parseProbe", () => {
  test("accepts the golden probe and recovers the challenge", () => {
    const probe = datagram(1, goldenRecord("discovery_probe_frame"));
    expect(parseProbe(PSK, probe)).toEqual(CHALLENGE);
  });

  test("wrong PSK is ignored", () => {
    const probe = datagram(1, goldenRecord("discovery_probe_frame"));
    const wrong = PSK.slice();
    wrong[0] = (wrong[0] ?? 0) ^ 0xff;
    expect(parseProbe(wrong, probe)).toBeNull();
  });

  test("bad magic, bad type, short and long datagrams are ignored", () => {
    const rec = goldenRecord("discovery_probe_frame");
    const badMagic = datagram(1, rec);
    badMagic[0] = 0x00;
    expect(parseProbe(PSK, badMagic)).toBeNull();
    expect(parseProbe(PSK, datagram(2, rec))).toBeNull(); // reply TYPE, not probe
    expect(parseProbe(PSK, new Uint8Array(0))).toBeNull();
    expect(parseProbe(PSK, new Uint8Array(200))).toBeNull(); // wrong exact length
  });

  test("domain separation: a TCP-context record cannot be a probe", () => {
    // Same plaintext/nonce/dir/seq, but sealed under the MSG context.
    const spliced = sealRecord(PSK, DIR_UP, 0n, 0n, CHALLENGE, undefined, AAD_MSG_CONTEXT);
    expect(parseProbe(PSK, datagram(1, spliced))).toBeNull();
  });
});

describe("buildReply", () => {
  test("reproduces the golden reply record with the fixed nonce", () => {
    const v = vectors.vectors.find((x) => x.name === "discovery_reply_frame");
    if (!v) throw new Error("missing vector");
    const reply = buildReply(PSK, CHALLENGE, 4791, fromHex(v.nonce_hex));
    expect(toHex(reply.subarray(5))).toBe(v.record_hex);
    expect(reply[4]).toBe(2); // TYPE reply
  });
});

describe("responder end-to-end (loopback UDP)", () => {
  test("replies to a valid probe with the advertised TCP port; ignores garbage", async () => {
    const responder = await startDiscoveryResponder({ psk: PSK, tcpPort: 12345, discoveryPort: 0 });
    try {
      const replies: Uint8Array[] = [];
      const client = await Bun.udpSocket({
        socket: {
          data(_sock, buf) {
            replies.push(new Uint8Array(buf));
          },
        },
      });
      try {
        // garbage first: no reply expected
        client.send(new Uint8Array([1, 2, 3]), responder.port, "127.0.0.1");
        // then a real probe
        const probe = datagram(1, sealRecord(PSK, DIR_UP, 0n, 0n, CHALLENGE, undefined, AAD_DSC_CONTEXT));
        client.send(probe, responder.port, "127.0.0.1");

        const deadline = Date.now() + 2000;
        while (replies.length === 0 && Date.now() < deadline) await Bun.sleep(10);
        expect(replies.length).toBe(1);

        const reply = replies[0]!;
        expect(reply[4]).toBe(2);
        // open it as the device would and check challenge + port
        const { openRecord, DIR_DOWN } = await import("@agentbus/protocol");
        const plain = openRecord(PSK, DIR_DOWN, 0n, 0n, reply.subarray(5), AAD_DSC_CONTEXT);
        expect(plain).not.toBeNull();
        expect(plain!.subarray(0, 8)).toEqual(CHALLENGE);
        expect(new DataView(plain!.buffer, plain!.byteOffset).getUint16(8, false)).toBe(12345);
      } finally {
        client.close();
      }
    } finally {
      responder.stop();
    }
  });
});
