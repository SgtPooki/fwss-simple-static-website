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
  providerAddress: "0xa3971A7234a3379A1813d9867B531e7EeB20ae07"
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
- `providerAddress` (default shown above): Override storage provider address (Calibration/Mainnet). Leave empty to allow auto-selection.

Caching details
- Cache key: `filecoin-pin-v1-${root_cid}` ensures uploads are skipped for identical content.
- You can invalidate all caches by changing the version prefix (e.g., `v2`).
- Retention is managed by GitHub Actions and organization settings; it’s not configurable per cache entry in actions/cache v4. Each restore updates last-access time.
