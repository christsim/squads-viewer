import { describe, it, expect } from "vitest";
import { parseMultisigAccount } from "../src/multisig";
import { Buffer } from "buffer";

// Synthetic multisig data for testing the Borsh parser.
// Uses deterministic values to verify correct field offsets.

// Instead of using real base64 data (which is large), construct a synthetic multisig
// that matches the known layout to test parsing logic.
function buildMultisigData(opts: {
  threshold?: number;
  timeLock?: number;
  txIndex?: number;
  staleTxIndex?: number;
  rentCollectorTag?: number;
  bump?: number;
  members?: { key: Buffer; mask: number }[];
}): Buffer {
  const disc = Buffer.alloc(8, 0); // discriminator
  const createKey = Buffer.alloc(32, 1);
  const configAuthority = Buffer.alloc(32, 0); // Pubkey::default = autonomous

  const threshold = Buffer.alloc(2);
  threshold.writeUInt16LE(opts.threshold ?? 2);

  const timeLock = Buffer.alloc(4);
  timeLock.writeUInt32LE(opts.timeLock ?? 0);

  const txIndex = Buffer.alloc(8);
  txIndex.writeBigUInt64LE(BigInt(opts.txIndex ?? 5));

  const staleTxIndex = Buffer.alloc(8);
  staleTxIndex.writeBigUInt64LE(BigInt(opts.staleTxIndex ?? 3));

  // rent_collector: Option<Pubkey> -- always 33 bytes (1 tag + 32 pubkey)
  const rentCollector = Buffer.alloc(33, 0);
  rentCollector.writeUInt8(opts.rentCollectorTag ?? 0);

  const bump = Buffer.alloc(1);
  bump.writeUInt8(opts.bump ?? 255);

  const members = opts.members ?? [
    { key: Buffer.alloc(32, 0xaa), mask: 7 },
    { key: Buffer.alloc(32, 0xbb), mask: 3 },
    { key: Buffer.alloc(32, 0xcc), mask: 5 },
  ];

  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(members.length);

  const memberBufs = members.map((m) => {
    const maskBuf = Buffer.alloc(1);
    maskBuf.writeUInt8(m.mask);
    return Buffer.concat([m.key, maskBuf]);
  });

  // Pad to simulate over-allocation (like the real program does)
  const padding = Buffer.alloc(10 * 33, 0);

  return Buffer.concat([
    disc,
    createKey,
    configAuthority,
    threshold,
    timeLock,
    txIndex,
    staleTxIndex,
    rentCollector,
    bump,
    vecLen,
    ...memberBufs,
    padding,
  ]);
}

describe("parseMultisigAccount", () => {
  it("parses threshold correctly", () => {
    const data = buildMultisigData({ threshold: 5 });
    const result = parseMultisigAccount("test-address", data);
    expect(result.threshold).toBe(5);
  });

  it("parses timeLock correctly", () => {
    const data = buildMultisigData({ timeLock: 3600 });
    const result = parseMultisigAccount("test-address", data);
    expect(result.timeLock).toBe(3600);
  });

  it("parses transactionIndex correctly", () => {
    const data = buildMultisigData({ txIndex: 42 });
    const result = parseMultisigAccount("test-address", data);
    expect(result.transactionIndex).toBe(42);
  });

  it("parses staleTransactionIndex correctly", () => {
    const data = buildMultisigData({ staleTxIndex: 10 });
    const result = parseMultisigAccount("test-address", data);
    expect(result.staleTransactionIndex).toBe(10);
  });

  it("parses bump correctly", () => {
    const data = buildMultisigData({ bump: 252 });
    const result = parseMultisigAccount("test-address", data);
    expect(result.bump).toBe(252);
  });

  it("parses correct number of members", () => {
    const data = buildMultisigData({});
    const result = parseMultisigAccount("test-address", data);
    expect(result.members).toHaveLength(3);
  });

  it("parses member permissions correctly", () => {
    const data = buildMultisigData({
      members: [
        { key: Buffer.alloc(32, 0xaa), mask: 7 }, // all permissions
        { key: Buffer.alloc(32, 0xbb), mask: 1 }, // proposer only
        { key: Buffer.alloc(32, 0xcc), mask: 2 }, // voter only
        { key: Buffer.alloc(32, 0xdd), mask: 4 }, // executor only
      ],
    });
    const result = parseMultisigAccount("test-address", data);

    expect(result.members[0].permissions.proposer).toBe(true);
    expect(result.members[0].permissions.voter).toBe(true);
    expect(result.members[0].permissions.executor).toBe(true);

    expect(result.members[1].permissions.proposer).toBe(true);
    expect(result.members[1].permissions.voter).toBe(false);
    expect(result.members[1].permissions.executor).toBe(false);

    expect(result.members[2].permissions.proposer).toBe(false);
    expect(result.members[2].permissions.voter).toBe(true);
    expect(result.members[2].permissions.executor).toBe(false);

    expect(result.members[3].permissions.proposer).toBe(false);
    expect(result.members[3].permissions.voter).toBe(false);
    expect(result.members[3].permissions.executor).toBe(true);
  });

  it("handles rent_collector = None (tag 0)", () => {
    const data = buildMultisigData({ rentCollectorTag: 0 });
    const result = parseMultisigAccount("test-address", data);
    expect(result.rentCollector).toBeNull();
  });

  it("handles rent_collector = Some (tag 1)", () => {
    const data = buildMultisigData({ rentCollectorTag: 1 });
    const result = parseMultisigAccount("test-address", data);
    // When tag=1, the 32 zero bytes are parsed as Pubkey::default
    expect(result.rentCollector).toBeTruthy();
  });

  it("preserves address passed in", () => {
    const data = buildMultisigData({});
    const result = parseMultisigAccount("my-multisig-address", data);
    expect(result.address).toBe("my-multisig-address");
  });

  it("configAuthority is Pubkey::default for autonomous multisig", () => {
    const data = buildMultisigData({});
    const result = parseMultisigAccount("test-address", data);
    expect(result.configAuthority).toBe("11111111111111111111111111111111");
  });
});
