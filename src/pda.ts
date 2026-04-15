import { PublicKey } from "@solana/web3.js";
import { SQUADS_V4_PROGRAM_ID } from "./types";

const PROGRAM_ID = new PublicKey(SQUADS_V4_PROGRAM_ID);
const SEED_PREFIX = Buffer.from("multisig");
const SEED_MULTISIG = Buffer.from("multisig");
const SEED_VAULT = Buffer.from("vault");
const SEED_TRANSACTION = Buffer.from("transaction");
const SEED_PROPOSAL = Buffer.from("proposal");

function toU8Bytes(n: number): Buffer {
  const buf = Buffer.alloc(1);
  buf.writeUInt8(n);
  return buf;
}

function toU64Bytes(n: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

export function getMultisigPda(createKey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_PREFIX, SEED_MULTISIG, createKey.toBytes()],
    PROGRAM_ID
  );
}

export function getVaultPda(
  multisigPda: PublicKey,
  index: number
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_PREFIX, multisigPda.toBytes(), SEED_VAULT, toU8Bytes(index)],
    PROGRAM_ID
  );
}

export function getTransactionPda(
  multisigPda: PublicKey,
  index: number | bigint
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_PREFIX, multisigPda.toBytes(), SEED_TRANSACTION, toU64Bytes(index)],
    PROGRAM_ID
  );
}

export function getProposalPda(
  multisigPda: PublicKey,
  transactionIndex: number | bigint
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      SEED_PREFIX,
      multisigPda.toBytes(),
      SEED_TRANSACTION,
      toU64Bytes(transactionIndex),
      SEED_PROPOSAL,
    ],
    PROGRAM_ID
  );
}

/**
 * Derive all vault PDAs for a given multisig, up to maxIndex.
 */
export function deriveVaults(
  multisigPda: PublicKey,
  maxIndex: number
): { index: number; address: string; bump: number }[] {
  const vaults: { index: number; address: string; bump: number }[] = [];
  for (let i = 0; i < maxIndex; i++) {
    const [pda, bump] = getVaultPda(multisigPda, i);
    vaults.push({ index: i, address: pda.toBase58(), bump });
  }
  return vaults;
}

/**
 * Try to find which multisig PDA + vault index produces a given vault address.
 * Used for reverse-lookup when user enters a vault address.
 */
export function matchVaultToMultisig(
  vaultAddress: string,
  multisigAddresses: string[],
  maxVaultIndex: number = 5
): { multisigPda: string; vaultIndex: number } | null {
  for (const msAddr of multisigAddresses) {
    const msPda = new PublicKey(msAddr);
    for (let i = 0; i < maxVaultIndex; i++) {
      const [vaultPda] = getVaultPda(msPda, i);
      if (vaultPda.toBase58() === vaultAddress) {
        return { multisigPda: msAddr, vaultIndex: i };
      }
    }
  }
  return null;
}
