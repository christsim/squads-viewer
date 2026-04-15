import type { MultisigInfo, MemberInfo, ProposalInfo } from "./types";
import { getAccountInfo, PublicKey } from "./solana";
import { getProposalPda, getTransactionPda } from "./pda";

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
  txIndex: number
): Promise<ProposalInfo> {
  const msPda = new PublicKey(multisigPda);
  const [transactionPda] = getTransactionPda(msPda, txIndex);
  const [proposalPda] = getProposalPda(msPda, txIndex);

  const info: ProposalInfo = {
    index: txIndex,
    transactionPda: transactionPda.toBase58(),
    proposalPda: proposalPda.toBase58(),
    status: "Closed",
    approved: [],
    rejected: [],
    cancelled: [],
    exists: false,
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
  //   ...status data (depends on variant)
  //   1   bump
  //   4 + N*32  approved vec
  //   4 + N*32  rejected vec
  //   4 + N*32  cancelled vec
  let offset = 8 + 32 + 8; // skip disc + multisig + tx_index

  const statusByte = data.readUInt8(offset);
  offset += 1;

  // Some status variants carry extra data (e.g. Approved has a timestamp)
  if (statusByte === 3 || statusByte === 4) {
    // Approved/Executing: has an i64 timestamp
    offset += 8;
  }

  info.status = PROPOSAL_STATUSES[statusByte] || `Unknown(${statusByte})`;

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
