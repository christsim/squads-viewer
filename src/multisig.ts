import type { MultisigInfo, MemberInfo, ProposalInfo } from "./types";
import { getAccountInfo, getSignaturesForAddress, getParsedTransaction, PublicKey } from "./solana";
import { getProposalPda, getTransactionPda } from "./pda";

// Note: getParsedTransaction returns custom program instruction data as BASE58,
// not base64. All instruction data decoding must use bs58Decode().
const BS58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Decode(str: string): Buffer {
  let result = 0n;
  for (const c of str) {
    const idx = BS58_ALPHABET.indexOf(c);
    if (idx < 0) throw new Error("Invalid base58");
    result = result * 58n + BigInt(idx);
  }
  let leadingZeros = 0;
  for (const c of str) { if (c === "1") leadingZeros++; else break; }
  const hex = result.toString(16);
  const padded = hex.length % 2 ? "0" + hex : hex;
  return Buffer.concat([Buffer.alloc(leadingZeros), Buffer.from(padded, "hex")]);
}

/**
 * Parse a Squads v4 Multisig account from raw data.
 * Layout (Borsh serialized, Anchor 8-byte discriminator):
 *   8   discriminator
 *   32  createKey
 *   32  configAuthority
 *   2   threshold (u16)
 *   4   timeLock (u32)
 *   8   transactionIndex (u64)
 *   8   staleTransactionIndex (u64)
 *   1   rent_collector Option tag (0=None, 1=Some)
 *   32  rent_collector Pubkey (ALWAYS 32 bytes even if None, per v4 realloc logic)
 *   1   bump (u8)
 *   4   members vec length (u32)
 *   N * 33  members (32 pubkey + 1 permissions mask)
 */
export function parseMultisigAccount(
  address: string,
  data: Buffer
): MultisigInfo {
  let offset = 8; // skip discriminator

  const createKey = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;

  const configAuthority = new PublicKey(
    data.subarray(offset, offset + 32)
  ).toBase58();
  offset += 32;

  const threshold = data.readUInt16LE(offset);
  offset += 2;

  const timeLock = data.readUInt32LE(offset);
  offset += 4;

  const transactionIndex = Number(data.readBigUInt64LE(offset));
  offset += 8;

  const staleTransactionIndex = Number(data.readBigUInt64LE(offset));
  offset += 8;

  // rent_collector: Option<Pubkey> -- always 33 bytes (1 tag + 32 pubkey)
  const rentCollectorTag = data.readUInt8(offset);
  offset += 1;
  const rentCollectorKey =
    rentCollectorTag === 1
      ? new PublicKey(data.subarray(offset, offset + 32)).toBase58()
      : null;
  offset += 32; // always 32 bytes regardless of tag

  const bump = data.readUInt8(offset);
  offset += 1;

  const membersLen = data.readUInt32LE(offset);
  offset += 4;

  const members: MemberInfo[] = [];
  for (let i = 0; i < membersLen && offset + 33 <= data.length; i++) {
    const memberKey = new PublicKey(
      data.subarray(offset, offset + 32)
    ).toBase58();
    offset += 32;

    const mask = data.readUInt8(offset);
    offset += 1;

    members.push({
      address: memberKey,
      permissions: {
        mask,
        proposer: (mask & 1) !== 0,
        voter: (mask & 2) !== 0,
        executor: (mask & 4) !== 0,
      },
    });
  }

  return {
    address,
    createKey,
    configAuthority,
    threshold,
    timeLock,
    transactionIndex,
    staleTransactionIndex,
    rentCollector: rentCollectorKey,
    bump,
    members,
  };
}

/**
 * Fetch and parse the multisig account from chain.
 */
export async function fetchMultisig(
  rpcUrl: string,
  multisigPda: string
): Promise<MultisigInfo> {
  const accountInfo = await getAccountInfo(rpcUrl, multisigPda);
  if (!accountInfo) {
    throw new Error("Multisig account not found on chain");
  }
  if (!accountInfo.data || accountInfo.data.length < 100) {
    throw new Error(
      "Account data too small to be a Squads v4 multisig config"
    );
  }
  return parseMultisigAccount(multisigPda, accountInfo.data as Buffer);
}

const PROPOSAL_STATUSES = [
  "Draft",
  "Active",
  "Rejected",
  "Approved",
  "Executing",
  "Executed",
  "Cancelled",
];

/**
 * Fetch proposal info for a given transaction index.
 */
export async function fetchProposal(
  rpcUrl: string,
  multisigPda: string,
  txIndex: number,
  staleTransactionIndex: number = 0
): Promise<ProposalInfo> {
  const msPda = new PublicKey(multisigPda);
  const [transactionPda] = getTransactionPda(msPda, txIndex);
  const [proposalPda] = getProposalPda(msPda, txIndex);

  const info: ProposalInfo = {
    index: txIndex,
    transactionPda: transactionPda.toBase58(),
    proposalPda: proposalPda.toBase58(),
    status: "None",
    approved: [],
    rejected: [],
    cancelled: [],
    exists: false,
    txType: "unknown",
    description: "",
    creator: null,
    vaultIndex: null,
    isPending: false,
    isStale: txIndex <= staleTransactionIndex,
    createdAt: null,
    executedAt: null,
    executionSignature: null,
    destination: null,
    destinationSns: null,
  };

  const accountInfo = await getAccountInfo(rpcUrl, proposalPda.toBase58());
  if (!accountInfo || !accountInfo.data) {
    return info;
  }

  info.exists = true;
  const data = accountInfo.data as Buffer;

  // Parse proposal:
  //   8   discriminator
  //   32  multisig pubkey
  //   8   transaction_index (u64)
  //   1   status enum tag
  //   8   timestamp (i64) -- present for ALL variants EXCEPT Executing (tag 4)
  //   1   bump
  //   4 + N*32  approved vec
  //   4 + N*32  rejected vec
  //   4 + N*32  cancelled vec
  let offset = 8 + 32 + 8; // skip disc + multisig + tx_index

  const statusByte = data.readUInt8(offset);
  offset += 1;

  // All status variants carry an i64 timestamp EXCEPT Executing (tag 4, deprecated)
  if (statusByte !== 4) {
    offset += 8; // skip timestamp
  }

  info.status = PROPOSAL_STATUSES[statusByte] || `Unknown(${statusByte})`;
  info.isPending = statusByte === 0 || statusByte === 1; // Draft or Active

  // bump
  offset += 1;

  // Parse vote vectors
  const parseVoteVec = (): string[] => {
    if (offset + 4 > data.length) return [];
    const len = data.readUInt32LE(offset);
    offset += 4;
    const keys: string[] = [];
    for (let i = 0; i < len && offset + 32 <= data.length; i++) {
      keys.push(new PublicKey(data.subarray(offset, offset + 32)).toBase58());
      offset += 32;
    }
    return keys;
  };

  info.approved = parseVoteVec();
  info.rejected = parseVoteVec();
  info.cancelled = parseVoteVec();

  return info;
}

// ─── Transaction Type Decoding ───────────────────────────────────────────────

const CONFIG_ACTION_LABELS = [
  "Add Member",
  "Remove Member",
  "Change Threshold",
  "Set Time Lock",
  "Add Spending Limit",
  "Remove Spending Limit",
  "Set Rent Collector",
];

const KNOWN_PROGRAM_LABELS: Record<string, string> = {
  "11111111111111111111111111111111": "System Program",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": "Token Program",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": "Token-2022",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL": "Associated Token",
  "ComputeBudget111111111111111111111111111111": "Compute Budget",
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf": "Squads v4",
};

/**
 * Fetch the transaction PDA and decode whether it's a VaultTransaction
 * or ConfigTransaction, and extract a human-readable description.
 * If the account is closed, recovers details from on-chain transaction history.
 */
export async function fetchTransactionType(
  rpcUrl: string,
  multisigPda: string,
  txIndex: number,
  proposal: ProposalInfo,
  vaultAddresses: string[] = []
): Promise<void> {
  const accountInfo = await getAccountInfo(rpcUrl, proposal.transactionPda);
  if (!accountInfo || !accountInfo.data) {
    // Account closed -- recover from transaction history
    await recoverClosedProposal(rpcUrl, proposal, vaultAddresses);
    return;
  }

  const data = accountInfo.data as Buffer;
  if (data.length < 82) {
    proposal.txType = "unknown";
    proposal.description = "Unknown";
    return;
  }

  // Both VaultTransaction and ConfigTransaction share the same first fields:
  //   8   discriminator
  //   32  multisig
  //   32  creator
  //   8   index (u64)
  //   1   bump

  const creator = new PublicKey(data.subarray(40, 72)).toBase58();
  proposal.creator = creator;

  // Try to detect type by checking if byte 81 looks like a vault_index (VaultTransaction)
  // or if offset 81 starts a vec length (ConfigTransaction).
  // More reliable: check the discriminator against known Anchor discriminators.
  // VaultTransaction discriminator: sha256("account:VaultTransaction")[0..8]
  // ConfigTransaction discriminator: sha256("account:ConfigTransaction")[0..8]
  // We'll compute these at runtime.

  const disc = data.subarray(0, 8);

  const vtDisc = await anchorDiscriminator("VaultTransaction");
  const ctDisc = await anchorDiscriminator("ConfigTransaction");

  if (disc.equals(Buffer.from(vtDisc))) {
    proposal.txType = "vault";
    parseVaultTransactionDescription(data, proposal);
  } else if (disc.equals(Buffer.from(ctDisc))) {
    proposal.txType = "config";
    parseConfigTransactionDescription(data, proposal);
  } else {
    proposal.txType = "unknown";
    proposal.description = "Unknown transaction type";
  }
}

let _discCache: Map<string, Uint8Array> = new Map();

async function anchorDiscriminator(name: string): Promise<Uint8Array> {
  const key = `account:${name}`;
  if (_discCache.has(key)) return _discCache.get(key)!;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(key));
  const result = new Uint8Array(hashBuffer).slice(0, 8);
  _discCache.set(key, result);
  return result;
}

/**
 * Parse a ConfigTransaction to extract the config action description.
 * Layout after shared header (offset 81):
 *   4   actions vec length
 *   N * variable  ConfigAction entries
 */
function parseConfigTransactionDescription(
  data: Buffer,
  proposal: ProposalInfo
): void {
  let offset = 81; // after disc(8) + multisig(32) + creator(32) + index(8) + bump(1)

  if (offset + 4 > data.length) {
    proposal.description = "Config transaction (unreadable)";
    return;
  }

  const actionsLen = data.readUInt32LE(offset);
  offset += 4;

  const descriptions: string[] = [];

  for (let i = 0; i < actionsLen && offset < data.length; i++) {
    const tag = data.readUInt8(offset);
    offset += 1;

    const label = CONFIG_ACTION_LABELS[tag] || `Unknown action (${tag})`;

    switch (tag) {
      case 0: {
        // AddMember: 32 pubkey + 1 permissions
        if (offset + 33 <= data.length) {
          const memberKey = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
          const mask = data.readUInt8(offset + 32);
          const perms: string[] = [];
          if (mask & 1) perms.push("Proposer");
          if (mask & 2) perms.push("Voter");
          if (mask & 4) perms.push("Executor");
          descriptions.push(`${label}: ${memberKey} [${perms.join(", ")}]`);
          offset += 33;
        } else {
          descriptions.push(label);
        }
        break;
      }
      case 1: {
        // RemoveMember: 32 pubkey
        if (offset + 32 <= data.length) {
          const memberKey = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
          descriptions.push(`${label}: ${memberKey}`);
          offset += 32;
        } else {
          descriptions.push(label);
        }
        break;
      }
      case 2: {
        // ChangeThreshold: u16
        if (offset + 2 <= data.length) {
          const newThreshold = data.readUInt16LE(offset);
          descriptions.push(`${label}: ${newThreshold}`);
          offset += 2;
        } else {
          descriptions.push(label);
        }
        break;
      }
      case 3: {
        // SetTimeLock: u32
        if (offset + 4 <= data.length) {
          const newTimeLock = data.readUInt32LE(offset);
          descriptions.push(`${label}: ${newTimeLock}s`);
          offset += 4;
        } else {
          descriptions.push(label);
        }
        break;
      }
      case 5: {
        // RemoveSpendingLimit: 32 pubkey
        if (offset + 32 <= data.length) {
          offset += 32;
        }
        descriptions.push(label);
        break;
      }
      case 6: {
        // SetRentCollector: Option<Pubkey> (1 tag + 0 or 32)
        if (offset < data.length) {
          const optTag = data.readUInt8(offset);
          offset += 1;
          if (optTag === 1 && offset + 32 <= data.length) {
            const collector = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
            descriptions.push(`${label}: ${collector}`);
            offset += 32;
          } else {
            descriptions.push(`${label}: None`);
          }
        } else {
          descriptions.push(label);
        }
        break;
      }
      default: {
        // AddSpendingLimit (4) or unknown -- skip rest
        descriptions.push(label);
        // Can't reliably skip variable-length AddSpendingLimit, stop parsing
        i = actionsLen;
        break;
      }
    }
  }

  proposal.description = descriptions.join("; ");
}

/**
 * Parse a VaultTransaction to extract a description of what it does.
 * Layout after shared header (offset 81):
 *   1   vault_index
 *   1   vault_bump
 *   4   ephemeral_signer_bumps vec length
 *   N   ephemeral_signer_bumps data
 *   --- VaultTransactionMessage ---
 *   1   num_signers
 *   1   num_writable_signers
 *   1   num_writable_non_signers
 *   4   account_keys vec length K
 *   K*32 account_keys
 *   4   instructions vec length I
 *   ... compiled instructions
 */
function parseVaultTransactionDescription(
  data: Buffer,
  proposal: ProposalInfo
): void {
  let offset = 81;

  if (offset + 2 > data.length) {
    proposal.description = "Vault transaction (unreadable)";
    return;
  }

  proposal.vaultIndex = data.readUInt8(offset);
  offset += 1; // vault_index
  offset += 1; // vault_bump

  // ephemeral_signer_bumps vec
  if (offset + 4 > data.length) { proposal.description = "Vault transaction"; return; }
  const ephLen = data.readUInt32LE(offset);
  offset += 4 + ephLen;

  // VaultTransactionMessage
  if (offset + 3 > data.length) { proposal.description = "Vault transaction"; return; }
  offset += 3; // num_signers, num_writable_signers, num_writable_non_signers

  // account_keys
  if (offset + 4 > data.length) { proposal.description = "Vault transaction"; return; }
  const numKeys = data.readUInt32LE(offset);
  offset += 4;

  const accountKeys: string[] = [];
  for (let k = 0; k < numKeys && offset + 32 <= data.length; k++) {
    accountKeys.push(new PublicKey(data.subarray(offset, offset + 32)).toBase58());
    offset += 32;
  }

  // instructions vec
  if (offset + 4 > data.length) { proposal.description = "Vault transaction"; return; }
  const numIxs = data.readUInt32LE(offset);
  offset += 4;

  const descriptions: string[] = [];

  for (let i = 0; i < numIxs && offset < data.length; i++) {
    // program_id_index (u8)
    const progIdx = data.readUInt8(offset);
    offset += 1;

    // account_indexes vec
    if (offset + 4 > data.length) break;
    const acctIdxLen = data.readUInt32LE(offset);
    offset += 4;
    const acctIdxes: number[] = [];
    for (let a = 0; a < acctIdxLen && offset < data.length; a++) {
      acctIdxes.push(data.readUInt8(offset));
      offset += 1;
    }

    // data vec
    if (offset + 4 > data.length) break;
    const ixDataLen = data.readUInt32LE(offset);
    offset += 4;
    const ixData = data.subarray(offset, offset + ixDataLen);
    offset += ixDataLen;

    // Resolve program
    const programKey = progIdx < accountKeys.length ? accountKeys[progIdx] : "Unknown";
    const programLabel = KNOWN_PROGRAM_LABELS[programKey] || programKey.slice(0, 8) + "...";

    // Try to decode known instructions
    const desc = decodeInstruction(programKey, ixData, acctIdxes, accountKeys);
    descriptions.push(desc || programLabel);
  }

  proposal.description = descriptions.filter(Boolean).join("; ") || "Vault transaction";
}

/**
 * Try to decode a known instruction into a human-readable string.
 */
function decodeInstruction(
  programKey: string,
  ixData: Buffer,
  accountIndexes: number[],
  accountKeys: string[]
): string | null {
  // System Program
  if (programKey === "11111111111111111111111111111111") {
    if (ixData.length >= 12) {
      const ixType = ixData.readUInt32LE(0);
      if (ixType === 2) {
        // Transfer
        const lamports = Number(ixData.readBigUInt64LE(4));
        const destination = accountIndexes.length >= 2 && accountIndexes[1] < accountKeys.length
          ? accountKeys[accountIndexes[1]]
          : "unknown";
        return `SOL Transfer: ${(lamports / 1e9).toFixed(4)} SOL → ${destination}`;
      }
    }
    return "System Program";
  }

  // Token Program / Token-2022: TransferChecked (instruction type 12)
  if (
    programKey === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ||
    programKey === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
  ) {
    if (ixData.length >= 10 && ixData.readUInt8(0) === 12) {
      // TransferChecked: u8(12) + u64(amount) + u8(decimals)
      const amount = Number(ixData.readBigUInt64LE(1));
      const decimals = ixData.readUInt8(9);
      const uiAmount = amount / Math.pow(10, decimals);
      const mint = accountIndexes.length >= 3 && accountIndexes[1] < accountKeys.length
        ? accountKeys[accountIndexes[1]]
        : "unknown";
      const destination = accountIndexes.length >= 4 && accountIndexes[2] < accountKeys.length
        ? accountKeys[accountIndexes[2]]
        : "unknown";
      return `Token Transfer: ${uiAmount} (mint: ${mint.slice(0, 8)}...) → ${destination}`;
    }
    if (ixData.length >= 9 && ixData.readUInt8(0) === 3) {
      // Transfer: u8(3) + u64(amount)
      const amount = Number(ixData.readBigUInt64LE(1));
      const destination = accountIndexes.length >= 3 && accountIndexes[1] < accountKeys.length
        ? accountKeys[accountIndexes[1]]
        : "unknown";
      return `Token Transfer: ${amount} → ${destination}`;
    }
    return "Token instruction";
  }

  // Compute Budget
  if (programKey === "ComputeBudget111111111111111111111111111111") {
    return null; // Skip -- not interesting to display
  }

  // ATA creation
  if (programKey === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL") {
    return "Create Token Account";
  }

  return null;
}

// ─── Closed Proposal Recovery ────────────────────────────────────────────────

// Squads v4 instruction discriminators: sha256("global:<name>")[0..8]
// Instruction data from getParsedTransaction is base58-encoded.
const DISC_CONFIG_TX_CREATE = "9bec57e4894b5127";
const DISC_VAULT_TX_CREATE = "30fa4ea8d0e2dad3";

/**
 * Recover details for a closed proposal by scanning the transaction PDA's
 * on-chain signature history. Even though the account data is deleted,
 * the address still has transaction history from create/execute/close.
 */
async function recoverClosedProposal(
  rpcUrl: string,
  proposal: ProposalInfo,
  vaultAddresses: string[]
): Promise<void> {
  try {
    const sigs = await getSignaturesForAddress(
      rpcUrl,
      proposal.transactionPda,
      5
    );

    if (sigs.length === 0) {
      proposal.description = "No history found";
      return;
    }

    // Sort by blockTime ascending to get: create, execute, close
    const sorted = [...sigs]
      .filter((s: any) => !s.err)
      .sort((a: any, b: any) => (a.blockTime || 0) - (b.blockTime || 0));

    if (sorted.length > 0) {
      proposal.createdAt = sorted[0].blockTime ?? null;
    }
    if (sorted.length >= 2) {
      proposal.executedAt = sorted[sorted.length >= 3 ? 1 : sorted.length - 1].blockTime ?? null;
    }

    // Parse ALL signatures to find create and execute transactions
    const parsedTxs: { sig: any; parsed: any }[] = [];
    for (const sig of sorted) {
      const parsed = await getParsedTransaction(rpcUrl, sig.signature);
      if (parsed) parsedTxs.push({ sig, parsed });
    }

    // Extract creator from the first (create) transaction
    if (parsedTxs.length > 0) {
      const createTx = parsedTxs[0].parsed;
      const feePayer = createTx.transaction?.message?.accountKeys?.[0];
      const payerKey = typeof feePayer === "string"
        ? feePayer
        : feePayer?.pubkey?.toBase58?.() || String(feePayer?.pubkey || "");
      if (payerKey) proposal.creator = payerKey;
    }

    // Try to find vault transaction (SOL/token transfer)
    for (const { sig, parsed } of parsedTxs) {
      const transfer = extractTransferFromParsedTx(parsed, vaultAddresses);
      if (transfer) {
        proposal.txType = "vault";
        proposal.description = transfer.description;
        proposal.destination = transfer.destination;
        proposal.vaultIndex = transfer.vaultIndex;
        proposal.executionSignature = sig.signature;
        proposal.executedAt = sig.blockTime ?? null;
        return;
      }
    }

    // Try to find config transaction by parsing the CREATE transaction's instruction data
    for (const { sig, parsed } of parsedTxs) {
      const configDesc = extractConfigFromCreateTx(parsed);
      if (configDesc) {
        proposal.txType = "config";
        proposal.description = configDesc;
        // Find the execute signature (the one after create)
        const createIdx = parsedTxs.indexOf(parsedTxs.find(p => p.sig === sig)!);
        if (createIdx < parsedTxs.length - 1) {
          proposal.executionSignature = parsedTxs[createIdx + 1].sig.signature;
          proposal.executedAt = parsedTxs[createIdx + 1].sig.blockTime ?? null;
        } else {
          proposal.executionSignature = sig.signature;
        }
        return;
      }
    }

    // Fallback: check logs to determine type
    for (const { sig, parsed } of parsedTxs) {
      const logs: string[] = parsed.meta?.logMessages || [];
      const isConfigExec = logs.some((l: string) => l.includes("ConfigTransactionExecute"));
      const isVaultExec = logs.some((l: string) => l.includes("VaultTransactionExecute"));
      if (isConfigExec) {
        proposal.txType = "config";
        proposal.description = "Config change (executed)";
        proposal.executionSignature = sig.signature;
        proposal.executedAt = sig.blockTime ?? null;
        return;
      }
      if (isVaultExec) {
        proposal.txType = "vault";
        proposal.description = "Vault transaction (executed)";
        proposal.executionSignature = sig.signature;
        proposal.executedAt = sig.blockTime ?? null;
        return;
      }
    }

    // If we found signatures but couldn't identify type
    if (sorted.length >= 2) {
      proposal.description = "Executed (details unavailable)";
      proposal.executionSignature = sorted.length >= 3
        ? sorted[1].signature
        : sorted[sorted.length - 1].signature;
    } else {
      proposal.description = "Transaction created";
    }
  } catch {
    proposal.description = "Recovery failed";
  }
}

interface TransferInfo {
  description: string;
  destination: string | null;
  vaultIndex: number | null;
}

/**
 * Extract SOL/token transfer details from a parsed transaction.
 * Looks for inner instructions from vault_transaction_execute.
 */
function extractTransferFromParsedTx(
  parsed: any,
  vaultAddresses: string[]
): TransferInfo | null {
  const instructions = parsed.transaction?.message?.instructions || [];
  const innerInstructions = parsed.meta?.innerInstructions || [];

  // Collect inner instructions (the actual CPI transfers from vault_transaction_execute)
  const allInnerIxs: any[] = [];
  for (const inner of innerInstructions) {
    allInnerIxs.push(...(inner.instructions || []));
  }

  // Determine which vault was involved
  const accountKeys = parsed.transaction?.message?.accountKeys || [];
  const allKeys = accountKeys.map((k: any) =>
    typeof k === "string" ? k : k?.pubkey
  );
  let vaultIndex: number | null = null;
  let vaultAddr: string | null = null;
  for (let i = 0; i < vaultAddresses.length; i++) {
    if (allKeys.includes(vaultAddresses[i])) {
      vaultIndex = i;
      vaultAddr = vaultAddresses[i];
      break;
    }
  }

  // Look for transfers in inner instructions
  for (const ix of allInnerIxs) {
    // System Program Transfer (SOL)
    if (ix.program === "system" && ix.parsed?.type === "transfer") {
      const info = ix.parsed.info;
      const lamports = info.lamports || 0;
      const amount = (lamports / 1e9).toFixed(6).replace(/\.?0+$/, "");
      const dest = info.destination;
      if (vaultAddr && info.source === vaultAddr) {
        return {
          description: `Send ${amount} SOL`,
          destination: dest,
          vaultIndex,
        };
      }
      if (vaultAddr && dest === vaultAddr) {
        return {
          description: `Receive ${amount} SOL`,
          destination: info.source,
          vaultIndex,
        };
      }
      // If vault not matched, still report the transfer
      return {
        description: `SOL Transfer: ${amount} SOL`,
        destination: dest,
        vaultIndex,
      };
    }

    // SPL Token TransferChecked
    if (
      (ix.program === "spl-token" || ix.program === "spl-token-2022") &&
      ix.parsed?.type === "transferChecked"
    ) {
      const info = ix.parsed.info;
      const amount = info.tokenAmount?.uiAmountString || "?";
      const mint = info.mint || "unknown";

      // Try to find destination owner from post-token balances
      const postBalances = parsed.meta?.postTokenBalances || [];
      let destOwner: string | null = null;
      for (const post of postBalances) {
        if (post.mint === mint && post.owner !== vaultAddr) {
          destOwner = post.owner;
          break;
        }
      }

      return {
        description: `Send ${amount} (${mint.slice(0, 8)}...)`,
        destination: destOwner,
        vaultIndex,
      };
    }

    // SPL Token Transfer (legacy)
    if (
      (ix.program === "spl-token" || ix.program === "spl-token-2022") &&
      ix.parsed?.type === "transfer"
    ) {
      const info = ix.parsed.info;
      const amount = info.amount || "?";
      return {
        description: `Token Transfer: ${amount}`,
        destination: info.destination,
        vaultIndex,
      };
    }
  }

  // Fallback: check SOL balance changes for the vault
  if (vaultAddr) {
    const preBalances = parsed.meta?.preBalances || [];
    const postBalances = parsed.meta?.postBalances || [];
    for (let k = 0; k < allKeys.length; k++) {
      if (allKeys[k] === vaultAddr && preBalances[k] !== undefined) {
        const diff = (postBalances[k] - preBalances[k]) / 1e9;
        // Ignore tiny amounts (likely rent changes, < 0.001 SOL)
        if (Math.abs(diff) > 0.001) {
          const amount = Math.abs(diff).toFixed(6).replace(/\.?0+$/, "");
          return {
            description: diff < 0 ? `Send ${amount} SOL` : `Receive ${amount} SOL`,
            destination: null,
            vaultIndex,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Extract config action details from a ConfigTransactionCreate instruction.
 * Looks for the Squads v4 program instruction with the ConfigTransactionCreate
 * discriminator and decodes the ConfigAction args from its data.
 */
function extractConfigFromCreateTx(parsed: any): string | null {
  const instructions = parsed.transaction?.message?.instructions || [];
  const squadsProgram = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

  for (const ix of instructions) {
    if ((ix.programId || ix.program) !== squadsProgram) continue;
    if (!ix.data) continue;

    let ixData: Buffer;
    try {
      ixData = bs58Decode(ix.data);
    } catch {
      continue;
    }
    if (ixData.length < 12) continue;

    const disc = ixData.subarray(0, 8).toString("hex");
    if (disc !== DISC_CONFIG_TX_CREATE) continue;

    // Found ConfigTransactionCreate instruction
    // Args after discriminator: Vec<ConfigAction> + Option<String> (memo)
    let offset = 8;

    // Vec<ConfigAction> length
    if (offset + 4 > ixData.length) return "Config change";
    const actionsLen = ixData.readUInt32LE(offset);
    offset += 4;

    const descriptions: string[] = [];
    for (let i = 0; i < actionsLen && offset < ixData.length; i++) {
      const tag = ixData.readUInt8(offset);
      offset += 1;
      const label = CONFIG_ACTION_LABELS[tag] || `Unknown action (${tag})`;

      switch (tag) {
        case 0: { // AddMember
          if (offset + 33 <= ixData.length) {
            const memberKey = new PublicKey(ixData.subarray(offset, offset + 32)).toBase58();
            const mask = ixData.readUInt8(offset + 32);
            const perms: string[] = [];
            if (mask & 1) perms.push("Proposer");
            if (mask & 2) perms.push("Voter");
            if (mask & 4) perms.push("Executor");
            descriptions.push(`${label}: ${memberKey} [${perms.join(", ")}]`);
            offset += 33;
          } else { descriptions.push(label); }
          break;
        }
        case 1: { // RemoveMember
          if (offset + 32 <= ixData.length) {
            const memberKey = new PublicKey(ixData.subarray(offset, offset + 32)).toBase58();
            descriptions.push(`${label}: ${memberKey}`);
            offset += 32;
          } else { descriptions.push(label); }
          break;
        }
        case 2: { // ChangeThreshold
          if (offset + 2 <= ixData.length) {
            descriptions.push(`${label}: ${ixData.readUInt16LE(offset)}`);
            offset += 2;
          } else { descriptions.push(label); }
          break;
        }
        case 3: { // SetTimeLock
          if (offset + 4 <= ixData.length) {
            descriptions.push(`${label}: ${ixData.readUInt32LE(offset)}s`);
            offset += 4;
          } else { descriptions.push(label); }
          break;
        }
        case 5: { // RemoveSpendingLimit
          if (offset + 32 <= ixData.length) offset += 32;
          descriptions.push(label);
          break;
        }
        case 6: { // SetRentCollector
          if (offset < ixData.length) {
            const optTag = ixData.readUInt8(offset);
            offset += 1;
            if (optTag === 1 && offset + 32 <= ixData.length) {
              const collector = new PublicKey(ixData.subarray(offset, offset + 32)).toBase58();
              descriptions.push(`${label}: ${collector}`);
              offset += 32;
            } else { descriptions.push(`${label}: None`); }
          } else { descriptions.push(label); }
          break;
        }
        default: {
          descriptions.push(label);
          i = actionsLen; // stop parsing
          break;
        }
      }
    }

    return descriptions.join("; ") || "Config change";
  }

  return null;
}
