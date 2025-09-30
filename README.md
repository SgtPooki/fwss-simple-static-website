# FWSS Simple Static Website

Minimal Vite-powered static site to test the Filecoin Pin GitHub Action. The homepage renders a centered headline:

  I am hosted on Filecoin

This repo includes a workflow that builds the site and uploads it to Filecoin via filecoin-pin/Synapse.

## Prerequisites

- A wallet private key funded appropriately for Calibration/Mainnet with USDFC (for testing: Calibration + faucet).

## Setup

1) Install dependencies and run locally

```
npm ci
npm run dev
```

2) Configure GitHub Secrets in this repo

- `FILECOIN_WALLET_KEY`: the private key used by the action to fund uploads.

3) Push to main

```
git checkout -b main
git commit -m "init"
git push -u origin main
```

## What the workflow does

File: `.github/workflows/upload.yml`

- Checks out this site repo
- Builds the site with Vite (output in `dist/`)
- Runs the local action from `.github/actions/filecoin-pin-upload-action`, which:
  - Packs the site into a UnixFS CAR
  - Ensures payment setup (minDays/minBalance + optional maxTopUp)
  - Uploads to Filecoin via Synapse
  - Publishes artifacts (CAR + metadata)
  - Comments on PRs with the IPFS Root CID (if running on PR events)

## Inputs used by the action

```
with:
  privateKey: ${{ secrets.FILECOIN_WALLET_KEY }}
  path: dist
  minDays: 10
  minBalance: "5"   # USDFC
  maxTopUp: "50"     # USDFC
```

Notes:
- The action currently supports USDFC only.
- Preview link uses a trustless gateway (placeholder) until infra is ready; artifacts include CAR and metadata.

## Troubleshooting

- PAT access: ensure `ACTIONS_READ_TOKEN` has `repo` scope and can access `filecoin-project/filecoin-pin`.
- Secrets from forks: if testing via PRs from forks, GitHub does not expose secrets by default; test on a branch push in this repo.
- Node version: workflow uses Node 20 for build (Vite), and the action uses Node 24 internally when it runs its own setup. Both are compatible.
