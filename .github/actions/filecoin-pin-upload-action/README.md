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
```

Notes:
- This local copy depends on the published `filecoin-pin` npm package (imports `filecoin-pin/dist/...`).
- For PR events, the action posts a comment with the IPFS Root CID.

