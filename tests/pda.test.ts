import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { getVaultPda, getTransactionPda, getProposalPda, deriveVaults, matchVaultToMultisig } from "../src/pda";

// Deterministic test multisig PDA derived from createKey = Buffer.alloc(32, 1)
const MULTISIG_PDA = "9Aqe8DJjBXEmbxMjoemg9VMhh5sqUsei1NEdke3QtNmS";

describe("getVaultPda", () => {
  it("derives vault 0 correctly", () => {
    const [pda, bump] = getVaultPda(new PublicKey(MULTISIG_PDA), 0);
    expect(pda.toBase58()).toBe("EGY9KCR8EaJPdfPExGyi5pFcrh2e6AtzG2D8imXYV48R");
    expect(bump).toBe(255);
  });

  it("derives vault 1 correctly", () => {
    const [pda, bump] = getVaultPda(new PublicKey(MULTISIG_PDA), 1);
    expect(pda.toBase58()).toBe("AwtsLvAoFYE45sASTpVuA4FW8Ws7DaC9AxHanxXcAgy2");
    expect(bump).toBe(253);
  });

  it("derives vault 2 correctly", () => {
    const [pda, bump] = getVaultPda(new PublicKey(MULTISIG_PDA), 2);
    expect(pda.toBase58()).toBe("E731izx2JhQEPtATiWJvV6b68EE9M7uCSR4btr72Eerr");
    expect(bump).toBe(255);
  });

  it("different indices produce different PDAs", () => {
    const [pda0] = getVaultPda(new PublicKey(MULTISIG_PDA), 0);
    const [pda1] = getVaultPda(new PublicKey(MULTISIG_PDA), 1);
    const [pda2] = getVaultPda(new PublicKey(MULTISIG_PDA), 2);
    expect(pda0.toBase58()).not.toBe(pda1.toBase58());
    expect(pda1.toBase58()).not.toBe(pda2.toBase58());
  });
});

describe("getTransactionPda", () => {
  it("derives transaction PDA for index 1", () => {
    const [pda] = getTransactionPda(new PublicKey(MULTISIG_PDA), 1);
    expect(pda.toBase58()).toBeTruthy();
    expect(pda.toBase58().length).toBeGreaterThan(30);
  });

  it("different indices produce different PDAs", () => {
    const [pda1] = getTransactionPda(new PublicKey(MULTISIG_PDA), 1);
    const [pda2] = getTransactionPda(new PublicKey(MULTISIG_PDA), 2);
    expect(pda1.toBase58()).not.toBe(pda2.toBase58());
  });
});

describe("getProposalPda", () => {
  it("derives proposal PDA for transaction index 1", () => {
    const [pda] = getProposalPda(new PublicKey(MULTISIG_PDA), 1);
    expect(pda.toBase58()).toBeTruthy();
    expect(pda.toBase58().length).toBeGreaterThan(30);
  });

  it("proposal PDA differs from transaction PDA for same index", () => {
    const [txPda] = getTransactionPda(new PublicKey(MULTISIG_PDA), 1);
    const [propPda] = getProposalPda(new PublicKey(MULTISIG_PDA), 1);
    expect(txPda.toBase58()).not.toBe(propPda.toBase58());
  });
});

describe("deriveVaults", () => {
  it("derives correct number of vaults", () => {
    const vaults = deriveVaults(new PublicKey(MULTISIG_PDA), 3);
    expect(vaults).toHaveLength(3);
    expect(vaults[0].index).toBe(0);
    expect(vaults[1].index).toBe(1);
    expect(vaults[2].index).toBe(2);
  });

  it("vault addresses match individual derivations", () => {
    const vaults = deriveVaults(new PublicKey(MULTISIG_PDA), 3);
    for (const v of vaults) {
      const [pda] = getVaultPda(new PublicKey(MULTISIG_PDA), v.index);
      expect(v.address).toBe(pda.toBase58());
    }
  });
});

describe("matchVaultToMultisig", () => {
  it("finds the correct multisig for a known vault address", () => {
    // Vault 2 of our test multisig
    const vaultAddress = "E731izx2JhQEPtATiWJvV6b68EE9M7uCSR4btr72Eerr";
    const result = matchVaultToMultisig(vaultAddress, [MULTISIG_PDA], 5);
    expect(result).not.toBeNull();
    expect(result!.multisigPda).toBe(MULTISIG_PDA);
    expect(result!.vaultIndex).toBe(2);
  });

  it("returns null when vault is not found in candidate list", () => {
    const result = matchVaultToMultisig(
      "E731izx2JhQEPtATiWJvV6b68EE9M7uCSR4btr72Eerr",
      ["11111111111111111111111111111111"],
      5
    );
    expect(result).toBeNull();
  });

  it("returns null when vault index exceeds scan range", () => {
    const result = matchVaultToMultisig(
      "E731izx2JhQEPtATiWJvV6b68EE9M7uCSR4btr72Eerr",
      [MULTISIG_PDA],
      2 // only scan 0-1, vault 2 won't be found
    );
    expect(result).toBeNull();
  });
});
