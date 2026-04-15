import { getAccountInfo, getProgramAccounts, PublicKey } from "./solana";
import { matchVaultToMultisig } from "./pda";
import {
  SQUADS_V4_PROGRAM_ID,
  SQUADS_VAULT_CHECK_API,
  type ResolutionMethod,
} from "./types";

export interface ResolveResult {
  multisigPda: string;
  inputWasVault: boolean;
  vaultIndex: number | null;
}

/**
 * Detect whether an address is a Squads v4 multisig config PDA or a vault address,
 * and resolve to the multisig PDA.
 */
export async function resolveAddress(
  rpcUrl: string,
  address: string,
  method: ResolutionMethod,
  vaultScanMax: number,
  onStatus: (msg: string) => void
): Promise<ResolveResult> {
  onStatus("Checking account type...");

  // Step 1: fetch account info
  const accountInfo = await getAccountInfo(rpcUrl, address);

  // If account is owned by the Squads v4 program and has data, it's the multisig PDA
  if (
    accountInfo &&
    accountInfo.owner.toBase58() === SQUADS_V4_PROGRAM_ID &&
    accountInfo.data.length > 50
  ) {
    return { multisigPda: address, inputWasVault: false, vaultIndex: null };
  }

  // Otherwise, assume it's a vault address. Try to find the parent multisig.
  onStatus("Address is not a multisig config. Resolving as vault...");

  // If using Squads API method, confirm it's a vault first
  if (method === "squads-api") {
    onStatus("Checking Squads vault API...");
    try {
      const apiResult = await checkSquadsVaultApi(address);
      if (!apiResult.isSquad) {
        throw new Error(
          "Address is neither a Squads multisig config nor a recognized vault"
        );
      }
      onStatus(`Confirmed as Squads ${apiResult.version} vault. Finding parent multisig...`);
    } catch (e) {
      onStatus("Squads API unavailable, falling back to on-chain scan...");
    }
  }

  // Use getProgramAccounts to find the parent multisig
  return await resolveVaultOnChain(rpcUrl, address, vaultScanMax, onStatus);
}

async function checkSquadsVaultApi(
  address: string
): Promise<{ isSquad: boolean; version: string }> {
  const response = await fetch(`${SQUADS_VAULT_CHECK_API}/${address}`);
  if (!response.ok) {
    throw new Error(`Vault check API returned ${response.status}`);
  }
  return response.json();
}

async function resolveVaultOnChain(
  rpcUrl: string,
  vaultAddress: string,
  vaultScanMax: number,
  onStatus: (msg: string) => void
): Promise<ResolveResult> {
  onStatus("Scanning all Squads multisigs on-chain (this may take a moment)...");

  // Anchor discriminator for Multisig account = sha256("account:Multisig")[0..8]
  // Pre-computed: [0xbe, 0x1e, 0x02, 0x52, 0x77, 0x4f, 0x6c, 0x22]
  // But let's compute it to be safe
  const discriminator = await computeDiscriminator("account:Multisig");

  let multisigAddresses: string[];
  try {
    const accounts = await getProgramAccounts(
      rpcUrl,
      SQUADS_V4_PROGRAM_ID,
      discriminator
    );
    multisigAddresses = accounts.map((a) => a.pubkey);
    onStatus(
      `Found ${multisigAddresses.length} multisig accounts. Matching vault...`
    );
  } catch (e) {
    throw new Error(
      `getProgramAccounts failed (RPC may not support it): ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // Now brute-force match vault PDAs
  const batchSize = 200;
  for (let i = 0; i < multisigAddresses.length; i += batchSize) {
    const batch = multisigAddresses.slice(i, i + batchSize);
    const match = matchVaultToMultisig(vaultAddress, batch, vaultScanMax);
    if (match) {
      onStatus(`Found! Vault index ${match.vaultIndex} of multisig ${match.multisigPda}`);
      return {
        multisigPda: match.multisigPda,
        inputWasVault: true,
        vaultIndex: match.vaultIndex,
      };
    }

    if (i + batchSize < multisigAddresses.length) {
      onStatus(
        `Searched ${Math.min(i + batchSize, multisigAddresses.length)}/${multisigAddresses.length} multisigs...`
      );
      // Yield to UI
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  throw new Error(
    "Could not find a Squads multisig that owns this vault address. " +
      "Try entering the multisig config PDA directly, or switch to a different RPC."
  );
}

async function computeDiscriminator(name: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const data = encoder.encode(name);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer).slice(0, 8);
}
