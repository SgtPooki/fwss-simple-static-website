# Filecoin Pin Upload Action (Local Copy)

This is a local copy of the composite action that packs a file/directory into a UnixFS CAR, uploads via `filecoin-pin` to Filecoin (Synapse), and publishes useful artifacts.

Use it from this repo via:

```yaml
uses: ./.github/actions/filecoin-pin-upload-action
with:
  privateKey: ${{ secrets.FILECOIN_WALLET_KEY }}
  path: dist
  minDays: 10
  minBalance: "5"   # USDFC
  maxTopUp: "50"     # USDFC
  cacheRetentionDays: "90"
```

Notes:
- This local copy depends on the published `filecoin-pin` npm package (imports `filecoin-pin/dist/...`).
- For PR events, the action posts a comment with the IPFS Root CID.

Inputs
- `privateKey` (required): Wallet private key.
- `path` (default: `dist`): Build output path.
- `minDays` (default: `10`): Minimum runway in days.
- `minBalance` (optional): Minimum deposit (USDFC).
- `maxTopUp` (optional): Maximum additional deposit (USDFC).
- `token` (default: `USDFC`): Supported token.
- `withCDN` (default: `false`): Request CDN if available.
- `cacheRetentionDays` (default: `90`): Retention for the GitHub Actions cache entries keyed by IPFS Root CID.

Caching details
- Cache key: `filecoin-pin-v1-${root_cid}` ensures uploads are skipped for identical content.
- You can invalidate all caches by changing the version prefix (e.g., `v2`).
- Retention is configurable via `cacheRetentionDays`; each restore extends the last-access time.
