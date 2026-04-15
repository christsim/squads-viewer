import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";

let _connection: Connection | null = null;
let _rpcUrl: string = "";

export function getConnection(rpcUrl: string): Connection {
  if (!_connection || _rpcUrl !== rpcUrl) {
    _connection = new Connection(rpcUrl, { commitment: "confirmed" });
    _rpcUrl = rpcUrl;
  }
  return _connection;
}

export function isValidPublicKey(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export async function getAccountInfo(
  rpcUrl: string,
  address: string
): Promise<AccountInfo<Buffer> | null> {
  const conn = getConnection(rpcUrl);
  const pubkey = new PublicKey(address);
  return conn.getAccountInfo(pubkey);
}

export async function getBalance(rpcUrl: string, address: string): Promise<number> {
  const conn = getConnection(rpcUrl);
  const pubkey = new PublicKey(address);
  const lamports = await conn.getBalance(pubkey);
  return lamports / 1e9;
}

export async function getTokenAccountsByOwner(
  rpcUrl: string,
  ownerAddress: string,
  tokenProgramId: string
): Promise<
  {
    pubkey: string;
    mint: string;
    balance: number;
    decimals: number;
    uiBalance: string;
  }[]
> {
  const conn = getConnection(rpcUrl);
  const owner = new PublicKey(ownerAddress);
  const tokenProgram = new PublicKey(tokenProgramId);

  const response = await conn.getParsedTokenAccountsByOwner(owner, {
    programId: tokenProgram,
  });

  return response.value.map((item) => {
    const parsed = item.account.data.parsed.info;
    return {
      pubkey: item.pubkey.toBase58(),
      mint: parsed.mint,
      balance: parsed.tokenAmount.amount,
      decimals: parsed.tokenAmount.decimals,
      uiBalance: parsed.tokenAmount.uiAmountString || "0",
    };
  });
}

export async function getSignaturesForAddress(
  rpcUrl: string,
  address: string,
  limit: number = 20
) {
  const conn = getConnection(rpcUrl);
  const pubkey = new PublicKey(address);
  return conn.getSignaturesForAddress(pubkey, { limit });
}

export async function getParsedTransaction(rpcUrl: string, signature: string) {
  const conn = getConnection(rpcUrl);
  return conn.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });
}

export async function getProgramAccounts(
  rpcUrl: string,
  programId: string,
  discriminator: Uint8Array
): Promise<{ pubkey: string; data: Buffer }[]> {
  const conn = getConnection(rpcUrl);
  const program = new PublicKey(programId);

  const accounts = await conn.getProgramAccounts(program, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: Buffer.from(discriminator).toString("base64"),
          encoding: "base64",
        },
      },
    ],
    dataSlice: { offset: 0, length: 0 },
  });

  return accounts.map((a) => ({
    pubkey: a.pubkey.toBase58(),
    data: a.account.data as Buffer,
  }));
}

export { PublicKey, Connection };
