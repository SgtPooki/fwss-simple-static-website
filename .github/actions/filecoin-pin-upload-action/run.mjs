import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import pc from 'picocolors'
import { ethers } from 'ethers'

// Import filecoin-pin internals to avoid CLI output parsing
import { initializeSynapse, createStorageContext, cleanupSynapseService } from 'filecoin-pin/dist/synapse/service.js'
import { checkAndSetAllowances, computeTopUpForDuration, getPaymentStatus, depositUSDFC } from 'filecoin-pin/dist/synapse/payments.js'
import { createCarFromPath } from 'filecoin-pin/dist/add/unixfs-car.js'
import { uploadToSynapse, getDownloadURL } from 'filecoin-pin/dist/synapse/upload.js'
import { validatePaymentSetup } from 'filecoin-pin/dist/common/upload-flow.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function getInput(name, fallback = '') {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim()
}

function parseBoolean(v) {
  if (typeof v === 'boolean') return v
  if (typeof v !== 'string') return false
  const s = v.trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

async function writeOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT
  if (!file) return
  await fs.appendFile(file, `\n${name}=${String(value ?? '')}\n`)
}

async function main() {
  const privateKey = getInput('privateKey')
  const contentPath = getInput('path', 'dist')
  const minDaysRaw = getInput('minDays', '10')
  const minBalanceRaw = getInput('minBalance', '')
  const maxTopUpRaw = getInput('maxTopUp', '')
  const withCDN = parseBoolean(getInput('withCDN', 'false'))
  const token = getInput('token', 'USDFC')

  if (!privateKey) {
    console.error('privateKey is required')
    process.exit(1)
  }

  const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

  // Resolve content path (relative to workspace)
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd()
  const targetPath = resolve(workspace, contentPath)

  // Parse values
  let minDays = Number(minDaysRaw)
  if (!Number.isFinite(minDays) || minDays < 0) minDays = 0
  const minBalance = minBalanceRaw ? ethers.parseUnits(minBalanceRaw, 18) : 0n
  const maxTopUp = maxTopUpRaw ? ethers.parseUnits(maxTopUpRaw, 18) : undefined

  // Validate token selection (currently USDFC only)
  if (token && token.toUpperCase() !== 'USDFC') {
    console.error('Only USDFC is supported at this time for payments. Token override will be enabled later.')
    process.exit(1)
  }

  // Initialize Synapse SDK (no storage context yet)
  const synapse = await initializeSynapse({ privateKey }, logger)
  const network = synapse.getNetwork()

  // Ensure WarmStorage allowances are at max (trusted service)
  await checkAndSetAllowances(synapse)

  // Check current payment status
  let status = await getPaymentStatus(synapse)

  // Compute top-up to satisfy minDays (days)
  let requiredTopUp = 0n
  if (minDays > 0) {
    const { topUp } = computeTopUpForDuration(status, minDays)
    if (topUp > requiredTopUp) requiredTopUp = topUp
  }

  // Ensure minimum deposit balance if specified
  if (minBalance > 0n && status.depositedAmount < minBalance) {
    const delta = minBalance - status.depositedAmount
    if (delta > requiredTopUp) requiredTopUp = delta
  }

  if (requiredTopUp > 0n) {
    if (maxTopUp != null && requiredTopUp > maxTopUp) {
      console.error(
        `Top-up required (${ethers.formatUnits(requiredTopUp, 18)} USDFC) exceeds maxTopUp (${ethers.formatUnits(maxTopUp, 18)} USDFC)`
      )
      process.exit(1)
    }

    console.log(`Depositing ${ethers.formatUnits(requiredTopUp, 18)} USDFC to Filecoin Pay ...`)
    await depositUSDFC(synapse, requiredTopUp)
    status = await getPaymentStatus(synapse)
  }

  // Determine if target path is a directory
  const stat = await fs.stat(targetPath)
  const isDirectory = stat.isDirectory()

  console.log(`Packing '${contentPath}' into CAR (UnixFS) ...`)
  const { carPath, rootCid } = await createCarFromPath(targetPath, { isDirectory, logger })

  // Read CAR data to upload
  const carBytes = await fs.readFile(carPath)

  // Validate payment capacity for the actual CAR size
  await validatePaymentSetup(synapse, carBytes.length)

  // Create storage context with optional CDN flag via env
  if (withCDN) process.env.WITH_CDN = 'true'
  const { storage, providerInfo } = await createStorageContext(synapse, logger, {})

  // Upload to Synapse and associate IPFS Root CID
  const synapseService = { synapse, storage, providerInfo }
  const { pieceCid, pieceId, dataSetId } = await uploadToSynapse(synapseService, carBytes, rootCid, logger, {
    contextId: `gha-upload-${Date.now()}`,
  })

  const providerId = providerInfo.id ?? ''
  const providerName = providerInfo.name ?? (providerInfo.serviceProvider || '')
  const previewURL = getDownloadURL(providerInfo, pieceCid) || `https://ipfs.io/ipfs/${rootCid.toString()}`

  // Prepare a clean artifact directory inside the workspace to avoid nested runner paths
  const artifactDir = join(workspace, 'filecoin-pin-artifacts')
  try {
    await fs.mkdir(artifactDir, { recursive: true })
  } catch (e) {
    console.error('Failed to create artifact directory:', e?.message || e)
  }

  // Copy CAR to artifact directory with a simple name
  const artifactCarPath = join(artifactDir, 'upload.car')
  await fs.copyFile(carPath, artifactCarPath)

  // Write metadata JSON into artifact directory
  const metadataPath = join(artifactDir, 'upload.json')
  await fs.writeFile(
    metadataPath,
    JSON.stringify(
      {
        network,
        contentPath: targetPath,
        carPath: artifactCarPath,
        rootCid: rootCid.toString(),
        pieceCid,
        pieceId,
        dataSetId,
        provider: { id: providerId, name: providerName },
        previewURL,
      },
      null,
      2
    )
  )

  // Set action outputs
  await writeOutput('root_cid', rootCid.toString())
  await writeOutput('data_set_id', dataSetId)
  await writeOutput('piece_cid', pieceCid)
  await writeOutput('provider_id', providerId)
  await writeOutput('provider_name', providerName)
  await writeOutput('car_path', artifactCarPath)
  await writeOutput('metadata_path', metadataPath)

  console.log('\n━━━ Filecoin Pin Upload Complete ━━━')
  console.log(`Network: ${network}`)
  console.log(`IPFS Root CID: ${pc.bold(rootCid.toString())}`)
  console.log(`Data Set ID: ${dataSetId}`)
  console.log(`Piece CID: ${pieceCid}`)
  console.log(`Provider: ${providerName} (ID ${providerId})`)
  console.log(`Preview: ${previewURL}`)

  // Append a concise summary to the GitHub Action run
  try {
    const summaryFile = process.env.GITHUB_STEP_SUMMARY
    if (summaryFile) {
      const md = [
        '## Filecoin Pin Upload',
        '',
        `- Network: ${network}`,
        `- IPFS Root CID: ${rootCid.toString()}`,
        `- Data Set ID: ${dataSetId}`,
        `- Piece CID: ${pieceCid}`,
        `- Provider: ${providerName} (ID ${providerId})`,
        `- Preview: ${previewURL}`,
        '',
        `Artifacts:`,
        `- CAR: ${artifactCarPath}`,
        `- Metadata: ${metadataPath}`,
        ''
      ].join('\n')
      await fs.appendFile(summaryFile, `\n${md}\n`)
    }
  } catch (e) {
    console.error('Failed to write summary:', e?.message || e)
  }

  await cleanupSynapseService()
}

main().catch(async (err) => {
  console.error('Upload failed:', err?.message || err)
  try {
    await cleanupSynapseService()
  } catch (e) {
    console.error('Cleanup failed:', e?.message || e)
  }
  process.exit(1)
})
