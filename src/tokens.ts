import { JUPITER_TOKEN_LIST_URL, JUPITER_PRICE_API_URL } from "./types";

interface JupiterToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI: string;
}

let tokenListCache: Map<string, JupiterToken> | null = null;

/**
 * Fetch the Jupiter strict token list and cache it.
 */
export async function fetchTokenList(): Promise<Map<string, JupiterToken>> {
  if (tokenListCache) return tokenListCache;

  try {
    const response = await fetch(JUPITER_TOKEN_LIST_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const tokens: JupiterToken[] = await response.json();
    tokenListCache = new Map(tokens.map((t) => [t.address, t]));
  } catch {
    tokenListCache = new Map();
  }
  return tokenListCache;
}

/**
 * Look up token metadata by mint address.
 */
export async function getTokenMeta(
  mint: string
): Promise<{ name: string; symbol: string; logoUri: string } | null> {
  const list = await fetchTokenList();
  const token = list.get(mint);
  if (!token) return null;
  return {
    name: token.name,
    symbol: token.symbol,
    logoUri: token.logoURI,
  };
}

/**
 * Fetch USD prices for a list of token mints + SOL.
 */
export async function fetchPrices(
  mints: string[]
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();

  // Always include SOL
  const solMint = "So11111111111111111111111111111111111111112";
  const allMints = [...new Set([solMint, ...mints])];

  if (allMints.length === 0) return prices;

  // Jupiter price API accepts comma-separated IDs
  // Batch into groups of 50 to avoid URL length limits
  const batchSize = 50;
  for (let i = 0; i < allMints.length; i += batchSize) {
    const batch = allMints.slice(i, i + batchSize);
    const ids = batch.join(",");

    try {
      const response = await fetch(`${JUPITER_PRICE_API_URL}?ids=${ids}`);
      if (!response.ok) continue;
      const result = await response.json();

      if (result.data) {
        for (const [mint, info] of Object.entries(result.data)) {
          const priceInfo = info as { price?: string | number };
          if (priceInfo.price) {
            prices.set(mint, Number(priceInfo.price));
          }
        }
      }
    } catch {
      // Price fetch failed, continue without prices
    }
  }

  // Map SOL native mint to a simple key
  const solPrice = prices.get(solMint);
  if (solPrice) {
    prices.set("SOL", solPrice);
  }

  return prices;
}

/**
 * Format a USD value for display.
 */
export function formatUsd(value: number | null): string {
  if (value === null || value === undefined) return "--";
  if (value < 0.01 && value > 0) return "<$0.01";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Format a token balance for display.
 */
export function formatBalance(balance: number, decimals: number = 4): string {
  if (balance === 0) return "0";
  if (balance < Math.pow(10, -decimals)) return `<${Math.pow(10, -decimals)}`;
  return balance.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}
