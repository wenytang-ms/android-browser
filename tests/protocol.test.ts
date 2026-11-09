import { describe, expect, it } from "vitest";
import {
  decodeMedia,
  encodeMedia,
  MAX_PACKET_BYTES,
  parseClientMessage,
  parseServerMessage,
  relayUrl,
} from "../src/shared/protocol.js";
import type { MediaPacket } from "../src/shared/protocol.js";

const packet: MediaPacket = {
  session: "a".repeat(32),
  stream: 2,
  sequence: 42,
  kind: "data",
  keyframe: true,
  pts: 1234567890123n,
  width: 1280,
  height: 720,
  data: new Uint8Array([0, 0, 0, 1, 0x65, 42]),
};

describe("versioned media protocol", () => {
  it("preserves the session, generation, sequence, PTS and exact encoded payload", () => {
    const encoded = encodeMedia(packet);
    const padded = new Uint8Array(encoded.length + 7);
    padded.set(encoded, 7);
    expect(decodeMedia(padded.subarray(7))).toEqual(packet);
  });

  it("rejects corrupt, truncated and oversized packets", () => {
    const corrupt = encodeMedia(packet);
    corrupt[4] = 2;
    expect(() => decodeMedia(corrupt)).toThrow();
    expect(() => decodeMedia(encodeMedia(packet).subarray(0, 54))).toThrow();
    expect(() => decodeMedia(new Uint8Array(MAX_PACKET_BYTES + 1))).toThrow();
    expect(() => encodeMedia({ ...packet, width: 0 })).toThrow();
  });

  it("rejects unknown RPCs, invalid credentials and unknown states instead of treating them as success", () => {
    expect(() => parseClientMessage('{"v":2,"type":"ping"}')).toThrow();
    expect(() => parseClientMessage('{"v":1,"type":"inject"}')).toThrow();
    expect(() =>
      parseClientMessage(
        JSON.stringify({
          v: 1,
          type: "auth",
          role: "viewer",
          session: packet.session,
          token: "id-is-not-a-credential",
        }),
      ),
    ).toThrow();
    expect(() =>
      parseServerMessage('{"v":1,"type":"state","state":"maybe"}'),
    ).toThrow();
  });

  it("requires secure public origins but allows loopback development", () => {
    expect(relayUrl("https://share.example.com").origin).toBe(
      "https://share.example.com",
    );
    expect(relayUrl("http://localhost:3000").origin).toBe(
      "http://localhost:3000",
    );
    for (const url of [
      "http://share.example.com",
      "https://user:secret@share.example.com",
      "https://share.example.com/path",
      "https://share.example.com/?token=x",
    ])
      expect(() => relayUrl(url)).toThrow();
  });
});
