const SNS_API_URL = "https://sns-api.bonfida.com/v2/user/domains";
const STORAGE_KEY = "squads-viewer-sns-cache";

// In-memory cache, seeded from localStorage
const cache = new Map<string, string | null>();

function loadCacheFromStorage(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const entries: [string, string | null][] = JSON.parse(raw);
      for (const [k, v] of entries) {
        cache.set(k, v);
      }
    }
  } catch {}
}

function saveCacheToStorage(): void {
  try {
    const entries = [...cache.entries()];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {}
}

// Load on module init
loadCacheFromStorage();

/**
 * Reverse-lookup a Solana address to its .sol domain name via the Bonfida API.
 * Returns the domain (e.g. "valr.sol") or null if not found.
 * Results are cached in memory and localStorage.
 */
export async function resolveSnsDomain(
  address: string
): Promise<string | null> {
  if (cache.has(address)) return cache.get(address)!;

  try {
    const response = await fetch(`${SNS_API_URL}/${address}`);
    if (!response.ok) {
      cache.set(address, null);
      saveCacheToStorage();
      return null;
    }
    const data = await response.json();
    // Bonfida API returns { "address": ["domain1", "domain2"] }
    const domains = data?.[address];
    const domain =
      Array.isArray(domains) && domains.length > 0 ? domains[0] : null;
    const fullDomain = domain ? `${domain}.sol` : null;
    cache.set(address, fullDomain);
    saveCacheToStorage();
    return fullDomain;
  } catch {
    cache.set(address, null);
    saveCacheToStorage();
    return null;
  }
}

/**
 * Batch-resolve multiple addresses. Returns a map of address -> domain | null.
 */
export async function batchResolveSnsDomains(
  addresses: string[]
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();
  const toResolve = addresses.filter((a) => !cache.has(a));

  // Resolve in parallel batches of 5
  const batchSize = 5;
  for (let i = 0; i < toResolve.length; i += batchSize) {
    const batch = toResolve.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (addr) => {
        const domain = await resolveSnsDomain(addr);
        results.set(addr, domain);
      })
    );
  }

  // Include cached results
  for (const addr of addresses) {
    if (!results.has(addr) && cache.has(addr)) {
      results.set(addr, cache.get(addr)!);
    }
  }

  return results;
}
