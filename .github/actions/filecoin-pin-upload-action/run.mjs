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
  const phase = process.env.ACTION_PHASE || 'single'
  const privateKey = getInput('privateKey')
  const contentPath = getInput('path', 'dist')
  const minDaysRaw = getInput('minDays', '10')
  const minBalanceRaw = getInput('minBalance', '')
  const maxTopUpRaw = getInput('maxTopUp', '')
  const withCDN = parseBoolean(getInput('withCDN', 'false'))
  const token = getInput('token', 'USDFC')
  const providerAddress = getInput('providerAddress', '0xa3971A7234a3379A1813d9867B531e7EeB20ae07')

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

  // If a provider override is supplied, set env so filecoin-pin picks it up in createStorageContext
  if (providerAddress) {
    process.env.PROVIDER_ADDRESS = providerAddress
  }

  // PHASE: compute -> pack only, set outputs and exit
  if (phase === 'compute') {
    const stat = await fs.stat(targetPath)
    const isDirectory = stat.isDirectory()
    console.log(`Packing '${contentPath}' into CAR (UnixFS) ...`)
    const { carPath, rootCid } = await createCarFromPath(targetPath, { isDirectory, logger })
    await writeOutput('root_cid', rootCid.toString())
    await writeOutput('car_path', carPath)
    return
  }

  // PHASE: from-cache -> read cached metadata and set outputs + summary
  if (phase === 'from-cache') {
    const fromArtifact = String(process.env.FROM_ARTIFACT || '').toLowerCase() === 'true'
    const cacheDir = process.env.CACHE_DIR
    const metaPath = join(cacheDir, 'upload.json')
    const text = await fs.readFile(metaPath, 'utf8')
    const meta = JSON.parse(text)

    await writeOutput('root_cid', meta.rootCid)
    await writeOutput('data_set_id', meta.dataSetId)
    await writeOutput('piece_cid', meta.pieceCid)
    await writeOutput('provider_id', meta.provider?.id || '')
    await writeOutput('provider_name', meta.provider?.name || '')
    await writeOutput('car_path', meta.carPath)
    await writeOutput('metadata_path', metaPath)
    await writeOutput('upload_status', fromArtifact ? 'reused-artifact' : 'reused-cache')

    // Log reuse status for easy scanning
    console.log(fromArtifact ? 'Reused previous artifact (no new upload)' : 'Reused cached metadata (no new upload)')

    // Ensure balances/allowances are still correct even when skipping upload
    try {
      const preparedCarPath = process.env.PREPARED_CAR_PATH || meta.carPath
      const carBytes = await fs.readFile(preparedCarPath)

      // Initialize Synapse and check allowances/deposits
      const synapse = await initializeSynapse({ privateKey }, logger)
      await checkAndSetAllowances(synapse)

      // Top-up logic based on minDays/minBalance
      let status = await getPaymentStatus(synapse)
      let requiredTopUp = 0n
      if (minDays > 0) {
        const { topUp } = computeTopUpForDuration(status, minDays)
        if (topUp > requiredTopUp) requiredTopUp = topUp
      }
      if (minBalance > 0n && status.depositedAmount < minBalance) {
        const delta = minBalance - status.depositedAmount
        if (delta > requiredTopUp) requiredTopUp = delta
      }
      if (requiredTopUp > 0n) {
        if (maxTopUp != null && requiredTopUp > maxTopUp) {
          throw new Error(
            `Top-up required (${ethers.formatUnits(requiredTopUp, 18)} USDFC) exceeds maxTopUp (${ethers.formatUnits(maxTopUp, 18)} USDFC)`
          )
        }
        console.log(`Depositing ${ethers.formatUnits(requiredTopUp, 18)} USDFC to maintain runway ...`)
        await depositUSDFC(synapse, requiredTopUp)
        status = await getPaymentStatus(synapse)
      }

      // Validate payment capacity for the (prepared) CAR size
      await validatePaymentSetup(synapse, carBytes.length)
    } catch (e) {
      console.warn('Balance/allowance validation on cache path failed:', e?.message || e)
    } finally {
      // IMPORTANT: Always cleanup providers so the Node process can exit
      try {
        await cleanupSynapseService()
      } catch {}
    }

    // Mirror the restored metadata into the standard cache location so a subsequent
    // actions/cache/save step can persist it keyed by Root CID.
    try {
      const workspace = process.env.GITHUB_WORKSPACE || process.cwd()
      const stdCacheDir = join(workspace, '.filecoin-pin-cache', meta.rootCid)
      await fs.mkdir(stdCacheDir, { recursive: true })
      await fs.writeFile(join(stdCacheDir, 'upload.json'), text)
    } catch (e) {
      console.warn('Failed to mirror metadata into .filecoin-pin-cache:', e?.message || e)
    }

    // Summary
    try {
      const summaryFile = process.env.GITHUB_STEP_SUMMARY
      if (summaryFile) {
        const md = [
          fromArtifact ? '## Filecoin Pin Upload (reused artifact)' : '## Filecoin Pin Upload (cached)',
          '',
          `- Network: ${meta.network}`,
          `- IPFS Root CID: \`${meta.rootCid}\``,
          `- Data Set ID: ${meta.dataSetId}`,
          `- Piece CID: ${meta.pieceCid}`,
          `- Provider: ${meta.provider?.name || ''} (ID ${meta.provider?.id || ''})`,
          `- Preview: ${meta.previewURL}`,
          `- Status: ${fromArtifact ? 'Reused artifact' : 'Reused cache'}`,
          '',
          `Artifacts:`,
          `- CAR: ${meta.carPath}`,
          `- Metadata: ${metaPath}`,
          ''
        ].join('\n')
        await fs.appendFile(summaryFile, `\n${md}\n`)
      }
    } catch {}

    return
  }

  // PHASE: upload (or default single-phase)
  const preparedCarPath = process.env.PREPARED_CAR_PATH
  const preparedRootCid = process.env.PREPARED_ROOT_CID

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

  // Prepare CAR and root
  let carPath = preparedCarPath
  let rootCidStr = preparedRootCid
  if (!carPath || !rootCidStr) {
    const stat = await fs.stat(targetPath)
    const isDirectory = stat.isDirectory()
    console.log(`Packing '${contentPath}' into CAR (UnixFS) ...`)
    const { carPath: cPath, rootCid } = await createCarFromPath(targetPath, { isDirectory, logger })
    carPath = cPath
    rootCidStr = rootCid.toString()
  }

  // Read CAR data to upload
  const carBytes = await fs.readFile(carPath)

  // Validate payment capacity for the actual CAR size
  await validatePaymentSetup(synapse, carBytes.length)

  // Create storage context with optional CDN flag via env
  if (withCDN) process.env.WITH_CDN = 'true'
  const { storage, providerInfo } = await createStorageContext(synapse, logger, {})

  // Upload to Synapse and associate IPFS Root CID
  const synapseService = { synapse, storage, providerInfo }
  const { pieceCid, pieceId, dataSetId } = await uploadToSynapse(synapseService, carBytes, { toString: () => rootCidStr }, logger, {
    contextId: `gha-upload-${Date.now()}`,
  })

  const providerId = providerInfo.id ?? ''
  const providerName = providerInfo.name ?? (providerInfo.serviceProvider || '')
  const previewURL = getDownloadURL(providerInfo, pieceCid) || `https://ipfs.io/ipfs/${rootCidStr}`

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
        rootCid: rootCidStr,
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

  // Also write metadata into the cache directory for future reuse
  try {
    const cacheDir = join(workspace, '.filecoin-pin-cache', rootCidStr)
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(join(cacheDir, 'upload.json'), await fs.readFile(metadataPath))
  } catch {}

  // Set action outputs
  await writeOutput('root_cid', rootCidStr)
  await writeOutput('data_set_id', dataSetId)
  await writeOutput('piece_cid', pieceCid)
  await writeOutput('provider_id', providerId)
  await writeOutput('provider_name', providerName)
  await writeOutput('car_path', artifactCarPath)
  await writeOutput('metadata_path', metadataPath)
  await writeOutput('upload_status', 'uploaded')

  console.log('\n━━━ Filecoin Pin Upload Complete ━━━')
  console.log(`Network: ${network}`)
  console.log(`IPFS Root CID: ${pc.bold(rootCidStr)}`)
  console.log(`Data Set ID: ${dataSetId}`)
  console.log(`Piece CID: ${pieceCid}`)
  console.log(`Provider: ${providerName} (ID ${providerId})`)
  console.log(`Preview: ${previewURL}`)
  console.log('Status: New upload performed')

  // Append a concise summary to the GitHub Action run
  try {
    const summaryFile = process.env.GITHUB_STEP_SUMMARY
    if (summaryFile) {
      const md = [
        '## Filecoin Pin Upload',
        '',
        `- Network: ${network}`,
        `- IPFS Root CID: ${rootCidStr}`,
        `- Data Set ID: ${dataSetId}`,
        `- Piece CID: ${pieceCid}`,
        `- Provider: ${providerName} (ID ${providerId})`,
        `- Preview: ${previewURL}`,
        `- Status: Uploaded`,
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
