export interface MultisigInfo {
  address: string;
  createKey: string;
  configAuthority: string;
  threshold: number;
  timeLock: number;
  transactionIndex: number;
  staleTransactionIndex: number;
  rentCollector: string | null;
  bump: number;
  members: MemberInfo[];
}

export interface MemberInfo {
  address: string;
  permissions: {
    mask: number;
    proposer: boolean;
    voter: boolean;
    executor: boolean;
  };
}

export interface VaultInfo {
  index: number;
  address: string;
  bump: number;
  solBalance: number;
  solUsd: number | null;
  tokens: TokenBalance[];
  activity: VaultTransaction[];
  loading: boolean;
}

export interface TokenBalance {
  mint: string;
  balance: number;
  decimals: number;
  uiBalance: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  usdValue: number | null;
  usdPrice: number | null;
}

export interface ProposalInfo {
  index: number;
  transactionPda: string;
  proposalPda: string;
  status: string;
  approved: string[];
  rejected: string[];
  cancelled: string[];
  exists: boolean;
  txType: "vault" | "config" | "unknown";
  description: string;
  creator: string | null;
  vaultIndex: number | null;
  isPending: boolean;
  createdAt: number | null;
  executedAt: number | null;
  executionSignature: string | null;
  destination: string | null;
  destinationSns: string | null;
}

export interface VaultTransaction {
  signature: string;
  blockTime: number | null;
  slot: number;
  err: boolean;
  direction: "in" | "out" | "unknown";
  amount: number | null;
  token: string | null;
  counterparty: string | null;
  memo: string | null;
}

export type ThemeName = "swiss-vault" | "mission-control" | "raw-protocol" | "dark-terminal";
export type ResolutionMethod = "squads-api" | "onchain-only";

export interface AppSettings {
  theme: ThemeName;
  rpcUrl: string;
  rpcCustom: string;
  heliusApiKey: string;
  resolutionMethod: ResolutionMethod;
  vaultScanMax: number;
  resolveSns: boolean;
}

export interface AppState {
  settings: AppSettings;
  addressInput: string;
  loading: boolean;
  resolving: boolean;
  resolvingStatus: string;
  error: string | null;
  multisig: MultisigInfo | null;
  vaults: VaultInfo[];
  proposals: ProposalInfo[];
  activeVaultTab: number;
  settingsOpen: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "swiss-vault",
  rpcUrl: "https://solana-rpc.publicnode.com",
  rpcCustom: "",
  heliusApiKey: "",
  resolutionMethod: "squads-api",
  vaultScanMax: 3,
  resolveSns: false,
};

export const SQUADS_V4_PROGRAM_ID = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
export const SQUADS_VAULT_CHECK_API = "https://4fnetmviidiqkjzenwxe66vgoa0soerr.lambda-url.us-east-1.on.aws/isSquad";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const JUPITER_TOKEN_LIST_URL = "https://token.jup.ag/strict";
export const JUPITER_PRICE_API_URL = "https://api.jup.ag/price/v2";

export const THEME_LABELS: Record<ThemeName, string> = {
  "swiss-vault": "Swiss Vault",
  "mission-control": "Mission Control",
  "raw-protocol": "Raw Protocol",
  "dark-terminal": "Dark Terminal",
};

export const RPC_PRESETS: { label: string; url: string; note?: string }[] = [
  { label: "PublicNode", url: "https://solana-rpc.publicnode.com", note: "CORS OK, works from local files" },
  { label: "Solana Tracker", url: "https://rpc.solanatracker.io/public?advancedTx=true", note: "CORS OK, works from local files" },
  { label: "Solana Public", url: "https://api.mainnet-beta.solana.com", note: "No CORS for local files, works when hosted" },
  { label: "Ankr", url: "https://rpc.ankr.com/solana", note: "Rate limited" },
];
