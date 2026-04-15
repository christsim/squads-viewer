import "./style.css";
import Alpine from "alpinejs";

import type {
  AppState,
  AppSettings,
  VaultInfo,
  TokenBalance,
  ProposalInfo,
  ThemeName,
} from "./types";
import {
  DEFAULT_SETTINGS,
  THEME_LABELS,
  RPC_PRESETS,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "./types";

import { resolveAddress } from "./resolve";
import { fetchMultisig, fetchProposal } from "./multisig";
import { deriveVaults } from "./pda";
import { isValidPublicKey, getBalance, getTokenAccountsByOwner, getSignaturesForAddress } from "./solana";
import { fetchTokenList, fetchPrices, getTokenMeta, formatUsd, formatBalance } from "./tokens";

// Expose to Alpine
(window as any).THEME_LABELS = THEME_LABELS;
(window as any).RPC_PRESETS = RPC_PRESETS;
(window as any).formatUsd = formatUsd;
(window as any).formatBalance = formatBalance;

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem("squads-viewer-settings");
    if (raw) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings: AppSettings): void {
  localStorage.setItem("squads-viewer-settings", JSON.stringify(settings));
}

function shortenAddress(addr: string, chars: number = 4): string {
  if (addr.length <= chars * 2 + 3) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

function solscanUrl(addr: string): string {
  return `https://solscan.io/account/${addr}`;
}

function solscanTxUrl(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

// Expose helpers
(window as any).shortenAddress = shortenAddress;
(window as any).solscanUrl = solscanUrl;
(window as any).solscanTxUrl = solscanTxUrl;

document.addEventListener("alpine:init", () => {
  Alpine.data("app", () => ({
    settings: loadSettings(),
    addressInput: "",
    loading: false,
    resolving: false,
    resolvingStatus: "",
    error: null as string | null,
    multisig: null as AppState["multisig"],
    vaults: [] as VaultInfo[],
    proposals: [] as ProposalInfo[],
    activeVaultTab: -1,
    settingsOpen: false,
    copied: "" as string,

    init() {
      this.applyTheme(this.settings.theme);
      // Parse URL hash
      const hash = window.location.hash.slice(1);
      if (hash && isValidPublicKey(hash)) {
        this.addressInput = hash;
        queueMicrotask(() => this.load());
      }
      // Listen for hash changes
      window.addEventListener("hashchange", () => {
        const h = window.location.hash.slice(1);
        if (h && isValidPublicKey(h) && h !== this.addressInput) {
          this.addressInput = h;
          this.load();
        }
      });
    },

    applyTheme(theme: ThemeName) {
      document.documentElement.setAttribute("data-theme", theme);
      this.settings.theme = theme;
      saveSettings(this.settings);
    },

    updateRpc(url: string) {
      this.settings.rpcUrl = url;
      saveSettings(this.settings);
    },

    updateCustomRpc(url: string) {
      this.settings.rpcCustom = url;
      if (url.trim()) {
        this.settings.rpcUrl = url.trim();
      }
      saveSettings(this.settings);
    },

    updateResolution(method: AppState["settings"]["resolutionMethod"]) {
      this.settings.resolutionMethod = method;
      saveSettings(this.settings);
    },

    persistSettings() {
      saveSettings(this.settings);
    },

    get rpcUrl(): string {
      return this.settings.rpcCustom?.trim() || this.settings.rpcUrl;
    },

    get totalUsd(): string {
      let total = 0;
      for (const v of this.vaults) {
        if (v.solUsd) total += v.solUsd;
        for (const t of v.tokens) {
          if (t.usdValue) total += t.usdValue;
        }
      }
      return formatUsd(total);
    },

    get totalSol(): string {
      let total = 0;
      for (const v of this.vaults) {
        total += v.solBalance;
      }
      return formatBalance(total, 6);
    },

    async copyToClipboard(text: string) {
      try {
        await navigator.clipboard.writeText(text);
        this.copied = text;
        setTimeout(() => {
          this.copied = "";
        }, 1500);
      } catch {}
    },

    async load() {
      const address = this.addressInput.trim();
      if (!address) {
        this.error = "Please enter an address";
        return;
      }
      if (!isValidPublicKey(address)) {
        this.error = "Invalid Solana address";
        return;
      }

      this.error = null;
      this.loading = true;
      this.resolving = true;
      this.resolvingStatus = "";
      this.multisig = null;
      this.vaults = [];
      this.proposals = [];
      this.activeVaultTab = -1;

      // Update URL hash
      window.location.hash = address;

      try {
        // Step 1: Resolve address to multisig PDA
        const resolved = await resolveAddress(
          this.rpcUrl,
          address,
          this.settings.resolutionMethod,
          this.settings.vaultScanMax,
          (msg: string) => {
            this.resolvingStatus = msg;
          }
        );
        this.resolving = false;

        // Step 2: Fetch multisig data
        this.resolvingStatus = "Loading multisig data...";
        const multisig = await fetchMultisig(this.rpcUrl, resolved.multisigPda);
        this.multisig = multisig;

        // Step 3: Derive vaults and fetch balances
        this.resolvingStatus = "Scanning vaults...";
        const vaultInfos = deriveVaults(
          new (await import("@solana/web3.js")).PublicKey(resolved.multisigPda),
          this.settings.vaultScanMax
        );

        this.vaults = vaultInfos.map((v) => ({
          index: v.index,
          address: v.address,
          bump: v.bump,
          solBalance: 0,
          solUsd: null,
          tokens: [],
          activity: [],
          loading: true,
        }));

        // Set active tab to vault with most balance (or the one from URL)
        if (resolved.inputWasVault && resolved.vaultIndex !== null) {
          this.activeVaultTab = resolved.vaultIndex;
        }

        // Fetch vault data in parallel
        await this.loadVaultData();

        // Step 4: Fetch proposals
        this.resolvingStatus = "Loading transactions...";
        await this.loadProposals();

        this.resolvingStatus = "";
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        this.resolving = false;
      } finally {
        this.loading = false;
      }
    },

    async loadVaultData() {
      // Fetch all vault SOL balances in parallel
      const balancePromises = this.vaults.map(async (vault: VaultInfo, _i: number) => {
        try {
          vault.solBalance = await getBalance(this.rpcUrl, vault.address);
        } catch {
          vault.solBalance = 0;
        }
      });
      await Promise.all(balancePromises);

      // Find first vault with balance if no active tab set
      if (this.activeVaultTab === -1) {
        const firstWithBalance = this.vaults.findIndex(
          (v: VaultInfo) => v.solBalance > 0
        );
        this.activeVaultTab = firstWithBalance >= 0 ? firstWithBalance : 0;
      }

      // Fetch token accounts for each vault
      const tokenPromises = this.vaults.map(
        async (vault: VaultInfo) => {
          try {
            const [tokenAccounts, token22Accounts] = await Promise.all([
              getTokenAccountsByOwner(this.rpcUrl, vault.address, TOKEN_PROGRAM_ID),
              getTokenAccountsByOwner(this.rpcUrl, vault.address, TOKEN_2022_PROGRAM_ID),
            ]);

            const allTokens = [...tokenAccounts, ...token22Accounts];
            vault.tokens = allTokens
              .filter((t) => Number(t.balance) > 0)
              .map((t) => ({
                mint: t.mint,
                balance: Number(t.uiBalance),
                decimals: t.decimals,
                uiBalance: t.uiBalance,
                name: null,
                symbol: null,
                logoUri: null,
                usdValue: null,
                usdPrice: null,
              }));
          } catch {
            vault.tokens = [];
          }
          vault.loading = false;
        }
      );
      await Promise.all(tokenPromises);

      // Enrich tokens with metadata and prices
      await this.enrichTokens();

      // Load activity for active vault
      await this.loadVaultActivity(this.activeVaultTab);
    },

    async enrichTokens() {
      // Collect all unique mints
      const allMints = new Set<string>();
      for (const vault of this.vaults) {
        for (const token of vault.tokens) {
          allMints.add(token.mint);
        }
      }

      // Fetch token metadata and prices in parallel
      const [tokenList, prices] = await Promise.all([
        fetchTokenList(),
        fetchPrices([...allMints]),
      ]);

      const solPrice = prices.get("SOL") || null;

      // Apply metadata and prices
      for (const vault of this.vaults) {
        // SOL USD value
        vault.solUsd = solPrice ? vault.solBalance * solPrice : null;

        for (const token of vault.tokens) {
          // Token metadata
          const meta = tokenList.get(token.mint);
          if (meta) {
            token.name = meta.name;
            token.symbol = meta.symbol;
            token.logoUri = meta.logoURI;
          }

          // Token price
          const price = prices.get(token.mint);
          if (price) {
            token.usdPrice = price;
            token.usdValue = token.balance * price;
          }
        }

        // Sort tokens by USD value descending
        vault.tokens.sort((a: TokenBalance, b: TokenBalance) => {
          return (b.usdValue || 0) - (a.usdValue || 0);
        });
      }
    },

    async loadProposals() {
      if (!this.multisig) return;

      const txCount = this.multisig.transactionIndex;
      if (txCount === 0) return;

      // Fetch last 20 proposals (or all if fewer)
      const start = Math.max(1, txCount - 19);
      const promises: Promise<ProposalInfo>[] = [];

      for (let i = txCount; i >= start; i--) {
        promises.push(fetchProposal(this.rpcUrl, this.multisig.address, i));
      }

      try {
        this.proposals = await Promise.all(promises);
      } catch {
        this.proposals = [];
      }
    },

    async loadVaultActivity(vaultIndex: number) {
      const vault = this.vaults[vaultIndex];
      if (!vault || vault.activity.length > 0) return;

      try {
        const signatures = await getSignaturesForAddress(
          this.rpcUrl,
          vault.address,
          20
        );

        vault.activity = signatures.map((sig: any) => ({
          signature: sig.signature,
          blockTime: sig.blockTime,
          slot: sig.slot,
          err: !!sig.err,
          direction: "unknown" as const,
          amount: null,
          token: null,
          counterparty: null,
          memo: sig.memo || null,
        }));
      } catch {
        vault.activity = [];
      }
    },

    async switchVaultTab(index: number) {
      this.activeVaultTab = index;
      await this.loadVaultActivity(index);
    },

    formatDate(timestamp: number | null): string {
      if (!timestamp) return "--";
      const d = new Date(timestamp * 1000);
      return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    },

    permissionBadges(member: any): string[] {
      const badges: string[] = [];
      if (member.permissions.proposer) badges.push("Proposer");
      if (member.permissions.voter) badges.push("Voter");
      if (member.permissions.executor) badges.push("Executor");
      return badges;
    },
  }));
});

Alpine.start();
