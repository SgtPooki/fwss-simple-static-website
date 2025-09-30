# FWSS Simple Static Website

Minimal Vite site used to test the Filecoin Pin GitHub Action. The page shows a centered headline:

  I am hosted on Filecoin

## Quick Start

1) Install and run locally

```
npm ci
npm run dev
```

2) Add secret in this repo

- `FILECOIN_WALLET_KEY`: wallet private key with USDFC (Calibration/Mainnet).

3) Push a change or run the workflow manually

- Workflow triggers: push to `main`, pull requests to `main`, and manual dispatch.

## Workflow Overview

File: `.github/workflows/upload.yml`

- Builds the site (Vite → `dist/`)
- Runs local action `.github/actions/filecoin-pin-upload-action` to:
  - Pack `dist/` into a UnixFS CAR
  - Ensure payment setup (minDays/minBalance, optional maxTopUp)
  - Upload via Synapse (or reuse prior upload if content unchanged)
  - Upload artifacts: `filecoin-pin-artifacts/upload.car`, `upload.json`
  - Comment on PRs with the IPFS Root CID

Caching behavior:
- Content is keyed by IPFS Root CID. If unchanged, the action reuses prior results from cache or a previous artifact, still verifying balances and capacity.

## Action Inputs (common ones)

```
with:
  privateKey: ${{ secrets.FILECOIN_WALLET_KEY }}
  path: dist
  minDays: 10
  minBalance: "5"     # USDFC
  maxTopUp: "50"      # USDFC
  providerAddress: "0xa3971A7234a3379A1813d9867B531e7EeB20ae07"  # optional override
  withCDN: "false"
```

Notes:
- Token support is currently USDFC only.
- The action summary shows whether it Uploaded, Reused cache, or Reused artifact, plus IDs and links. Artifacts include the CAR and metadata.
- Secrets are not exposed to forked PRs; the job is skipped there.
- Security: If you run uploads on PRs, PR authors can change inputs that influence deposits/top-ups. Set a conservative `maxTopUp`, protect workflow files, and require reviews.
