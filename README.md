# Squads Viewer

A read-only, single-page viewer for [Squads Protocol v4](https://squads.so) multisig accounts on Solana.

View all your Squad details -- vaults, balances, members, transactions -- without connecting a wallet or needing a subscription.

## Features

- **Read-only** -- no wallet connection, no write operations, no signing
- **Enter any address** -- accepts multisig config PDAs or vault addresses (auto-resolves vault to parent multisig)
- **All vaults** -- scans vault PDAs (0-N), shows SOL and SPL token balances including Token-2022
- **USD values** -- token names, symbols, logos, and prices via Jupiter API
- **Members table** -- all members with permission badges (Proposer/Voter/Executor)
- **Transaction history** -- proposal status, approvers, rejectors for on-chain transactions
- **Vault activity feed** -- recent transfers per vault with Solscan links
- **4 switchable themes** -- Swiss Vault, Mission Control, Raw Protocol, Dark Terminal
- **Configurable RPC** -- multiple tested public endpoints, or bring your own
- **Self-contained** -- builds to a single HTML file with all JS, CSS, and fonts inlined. Zero runtime code dependencies.
- **URL hash routing** -- shareable links like `#<multisig-address>`

## Usage

### Online

Visit: [https://christsim.github.io/squads-viewer/](https://christsim.github.io/squads-viewer/)

### Offline

1. Download `index.html` from the [latest release](https://github.com/christsim/squads-viewer/releases/latest)
2. Verify the SHA-256 checksum: `shasum -a 256 index.html`
3. Open the file in any browser

### From source

```bash
npm install
npm run build
open dist/index.html
```

## Development

```bash
# Install dependencies
npm install

# Dev server (hot reload)
npm run dev

# Run tests
npm test

# Production build (single HTML file)
npm run build
# Output: dist/index.html
```

## Disclaimer

**USE AT YOUR OWN RISK.** This tool is provided as-is for informational purposes only.
It does not guarantee the accuracy of any data displayed. All data is fetched directly
from the Solana blockchain and third-party APIs (Jupiter). The authors accept no
liability for any decisions made based on information displayed by this tool.

## License

[MIT](LICENSE)
