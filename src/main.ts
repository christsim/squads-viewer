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
import { fetchMultisig, fetchProposal, fetchTransactionType } from "./multisig";
import { deriveVaults } from "./pda";
import { isValidPublicKey, getBalance, getTokenAccountsByOwner, getSignaturesForAddress, getParsedTransaction } from "./solana";
import { fetchTokenList, fetchPrices, getTokenMeta, formatUsd, formatBalance } from "./tokens";
import { batchResolveSnsDomains } from "./sns";
import { getLabel, setLabel, getAllLabels } from "./labels";

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

function resolveTokenDisplay(token: string | null): string {
  if (!token) return "--";
  if (token === "SOL" || token === "SPL Token") return token;
  // If it looks like a mint address, shorten it
  if (token.length > 20) return shortenAddress(token, 4);
  return token;
}

// Expose helpers
(window as any).shortenAddress = shortenAddress;
(window as any).solscanUrl = solscanUrl;
(window as any).solscanTxUrl = solscanTxUrl;
(window as any).resolveTokenDisplay = resolveTokenDisplay;

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
    addressLabels: getAllLabels() as Record<string, string>,

    init() {
      this.applyTheme(this.settings.theme);

      // Parse hash into address and optional query params
      // Supports: #ADDRESS?helius-key=KEY or #ADDRESS/?helius-key=KEY
      const rawHash = window.location.hash.slice(1);
      const [hashPath, hashQuery] = rawHash.split("?", 2);
      const hashAddr = hashPath.replace(/\/+$/, ""); // strip trailing slashes

      // Parse ?helius-key=... from query string or hash query params
      const params = window.location.search
        ? new URLSearchParams(window.location.search)
        : new URLSearchParams(hashQuery || "");
      const heliusKey = params.get("helius-key");
      if (heliusKey && heliusKey.trim()) {
        this.settings.heliusApiKey = heliusKey.trim();
        this.settings.rpcUrl = "helius";
        this.settings.rpcCustom = "";
        saveSettings(this.settings);
        // Clean URL: keep only pathname + bare hash address
        const cleanUrl = window.location.pathname + (hashAddr ? "#" + hashAddr : "");
        window.history.replaceState(null, "", cleanUrl);
      }

      // Parse URL hash for multisig address
      if (hashAddr && isValidPublicKey(hashAddr)) {
        this.addressInput = hashAddr;
        queueMicrotask(() => this.load());
      }
      // Listen for hash changes
      window.addEventListener("hashchange", () => {
        const h = window.location.hash.slice(1).split("?")[0].replace(/\/+$/, "");
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

    get activeVault(): VaultInfo | null {
      if (this.activeVaultTab >= 0 && this.activeVaultTab < this.vaults.length) {
        return this.vaults[this.activeVaultTab];
      }
      return null;
    },

    get filteredActivity(): any[] {
      if (!this.activeVault) return [];
      return this.activeVault.activity.filter((tx: any) => {
        // Always show txs where the counterparty has a label
        const hasLabel = tx.counterparty && this.addressLabels[tx.counterparty];
        if (hasLabel) return true;

        // Hide failed txs unless setting enabled
        if (tx.err && !this.settings.showFailedTxs) return false;
        // Hide small inbound deposits (poisoning filter)
        if (
          tx.direction === "in" &&
          tx.amount !== null &&
          tx.amount < this.settings.minDepositSol &&
          tx.token === "SOL"
        ) {
          return false;
        }
        return true;
      });
    },

    get rpcUrl(): string {
      if (this.settings.rpcCustom?.trim()) return this.settings.rpcCustom.trim();
      if (this.settings.rpcUrl === "helius" && this.settings.heliusApiKey?.trim()) {
        return `https://mainnet.helius-rpc.com/?api-key=${this.settings.heliusApiKey.trim()}`;
      }
      return this.settings.rpcUrl;
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

    labelAddress(address: string) {
      const current = getLabel(address) || "";
      const label = prompt(`Label for ${address.slice(0, 12)}...`, current);
      if (label !== null) {
        setLabel(address, label);
        this.addressLabels = getAllLabels();
      }
    },

    displayName(address: string): string | null {
      return this.addressLabels[address] || null;
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

    proposalsLoading: false,

    async loadProposals() {
      if (!this.multisig) return;

      const txCount = this.multisig.transactionIndex;
      if (txCount === 0) return;

      this.proposalsLoading = true;

      // Fetch last 20 proposals (or all if fewer)
      const start = Math.max(1, txCount - 19);
      const promises: Promise<ProposalInfo>[] = [];

      for (let i = txCount; i >= start; i--) {
        promises.push(fetchProposal(this.rpcUrl, this.multisig.address, i));
      }

      try {
        this.proposals = await Promise.all(promises);

        // Collect vault addresses for cross-referencing
        const vaultAddrs = this.vaults.map((v: VaultInfo) => v.address);

        // Fetch transaction types for all proposals (open and closed)
        // Closed proposals will recover from transaction history
        const batchSize = 5;
        for (let i = 0; i < this.proposals.length; i += batchSize) {
          const batch = this.proposals.slice(i, i + batchSize);
          await Promise.all(
            batch.map((p: ProposalInfo) =>
              fetchTransactionType(this.rpcUrl, this.multisig!.address, p.index, p, vaultAddrs).catch(() => {})
            )
          );
          if (i + batchSize < this.proposals.length) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }

        // Resolve SNS domains for destinations if enabled
        if (this.settings.resolveSns) {
          await this.resolveProposalSns();
        }
      } catch {
        this.proposals = [];
      } finally {
        this.proposalsLoading = false;
      }
    },

    async resolveProposalSns() {
      const destinations = this.proposals
        .map((p: ProposalInfo) => p.destination)
        .filter((d: string | null): d is string => !!d);

      const unique = [...new Set(destinations)];
      if (unique.length === 0) return;

      const resolved = await batchResolveSnsDomains(unique);
      for (const p of this.proposals) {
        if (p.destination && resolved.has(p.destination)) {
          p.destinationSns = resolved.get(p.destination) || null;
        }
      }
    },

    activityLoading: false,

    async loadVaultActivity(vaultIndex: number) {
      const vault = this.vaults[vaultIndex];
      if (!vault || vault.activity.length > 0) return;

      this.activityLoading = true;

      try {
        const signatures = await getSignaturesForAddress(
          this.rpcUrl,
          vault.address,
          10
        );

        // Initialize with basic info
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

        // Fetch and parse transaction details in batches of 5
        const batchSize = 5;
        for (let i = 0; i < vault.activity.length; i += batchSize) {
          const batch = vault.activity.slice(i, i + batchSize);
          const parsedBatch = await Promise.all(
            batch.map((tx: any) =>
              getParsedTransaction(this.rpcUrl, tx.signature).catch(() => null)
            )
          );

          for (let j = 0; j < parsedBatch.length; j++) {
            const parsed = parsedBatch[j];
            if (!parsed) continue;
            const tx = vault.activity[i + j];
            this.parseTransactionDetails(tx, parsed, vault.address);
          }

          // Small delay between batches to avoid rate limiting
          if (i + batchSize < vault.activity.length) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }

        // Resolve token mint addresses to symbols using cached token list
        const tokenList = await fetchTokenList();
        for (const tx of vault.activity) {
          if (tx.token && tx.token !== "SOL" && tx.token !== "SPL Token" && tx.token.length > 20) {
            const meta = tokenList.get(tx.token);
            if (meta) {
              tx.token = meta.symbol;
            }
          }
        }
      } catch {
        vault.activity = [];
      } finally {
        this.activityLoading = false;
      }
    },

    parseTransactionDetails(tx: any, parsed: any, vaultAddress: string) {
      const instructions = parsed.transaction?.message?.instructions || [];
      const innerInstructions = parsed.meta?.innerInstructions || [];

      // Collect all instructions (top-level + inner)
      const allIxs = [...instructions];
      for (const inner of innerInstructions) {
        allIxs.push(...(inner.instructions || []));
      }

      // Look for SOL transfers and token transfers
      for (const ix of allIxs) {
        // System Program Transfer (SOL)
        if (ix.program === "system" && ix.parsed?.type === "transfer") {
          const info = ix.parsed.info;
          const lamports = info.lamports || 0;
          const amount = lamports / 1e9;

          if (info.destination === vaultAddress) {
            tx.direction = "in";
            tx.amount = amount;
            tx.token = "SOL";
            tx.counterparty = info.source;
            return;
          } else if (info.source === vaultAddress) {
            tx.direction = "out";
            tx.amount = amount;
            tx.token = "SOL";
            tx.counterparty = info.destination;
            return;
          }
        }

        // SPL Token TransferChecked
        if (
          (ix.program === "spl-token" || ix.program === "spl-token-2022") &&
          ix.parsed?.type === "transferChecked"
        ) {
          const info = ix.parsed.info;
          const amount = parseFloat(info.tokenAmount?.uiAmountString || "0");
          const mint = info.mint || "";

          // Determine direction from pre/post token balances
          const preBalances = parsed.meta?.preTokenBalances || [];
          const postBalances = parsed.meta?.postTokenBalances || [];

          // Check if vault is the source or destination owner
          const sourceOwner = info.authority || info.multisigAuthority;
          if (sourceOwner === vaultAddress) {
            tx.direction = "out";
            tx.amount = amount;
            tx.token = mint;
            // Find destination owner from post-token balances
            for (const post of postBalances) {
              if (post.mint === mint && post.owner !== vaultAddress) {
                tx.counterparty = post.owner;
                break;
              }
            }
            return;
          }

          // Check if vault is the destination
          for (const post of postBalances) {
            if (post.mint === mint && post.owner === vaultAddress) {
              const pre = preBalances.find(
                (p: any) => p.mint === mint && p.owner === vaultAddress
              );
              const preAmount = parseFloat(
                pre?.uiTokenAmount?.uiAmountString || "0"
              );
              const postAmount = parseFloat(
                post.uiTokenAmount?.uiAmountString || "0"
              );
              if (postAmount > preAmount) {
                tx.direction = "in";
                tx.amount = amount;
                tx.token = mint;
                tx.counterparty = sourceOwner || null;
                return;
              }
            }
          }
        }

        // SPL Token Transfer (legacy, no checked)
        if (
          (ix.program === "spl-token" || ix.program === "spl-token-2022") &&
          ix.parsed?.type === "transfer"
        ) {
          const info = ix.parsed.info;
          const amount = parseFloat(info.amount || "0");
          const authority = info.authority || info.multisigAuthority;

          if (authority === vaultAddress) {
            tx.direction = "out";
            tx.amount = amount;
            tx.token = "SPL Token";
            tx.counterparty = info.destination;
            return;
          }
        }
      }

      // If no transfer found, check SOL balance changes
      const accountKeys = parsed.transaction?.message?.accountKeys || [];
      const preBalances = parsed.meta?.preBalances || [];
      const postBalances = parsed.meta?.postBalances || [];

      for (let k = 0; k < accountKeys.length; k++) {
        const key =
          typeof accountKeys[k] === "string"
            ? accountKeys[k]
            : accountKeys[k]?.pubkey;
        if (key === vaultAddress && preBalances[k] !== undefined) {
          const diff = (postBalances[k] - preBalances[k]) / 1e9;
          if (Math.abs(diff) > 0.000001) {
            tx.direction = diff > 0 ? "in" : "out";
            tx.amount = Math.abs(diff);
            tx.token = "SOL";
            return;
          }
        }
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
