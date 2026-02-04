#!/usr/bin/env tsx
/**
 * Belt UserOp Monitor
 * 
 * Independent notification service for Belt AA operations.
 * Uses the SAME Redis instance and key structure as belt-indexer.
 * All notification logic lifted from indexer - complete separation of concerns.
 */

import { GraphQLClient, gql } from 'graphql-request'
import Redis from 'ioredis'
import { notifyUserOp, notifyAccountDeployed } from './discord'
import type { UserOpInfo, DeployInfo, WalletState } from './discord'

const INDEXER_URL = process.env.BELT_INDEXER_URL || 'https://belt-indexer-production.up.railway.app/graphql'
const POLL_INTERVAL_MS = 10_000 // 10 seconds
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

// Redis keys matching indexer pattern
const WATERMARK_PREFIX = 'belt:notifications:watermark'
const EVENT_PREFIX = 'belt:notifications:event:'
const EVENT_TTL = 60 * 60 * 24 * 30 // 30 days (matches indexer)

interface UserOpEvent {
  id: string
  txHash: string
  sender: string
  paymaster: string | null
  actualGasCost: string
  actualGasUsed: string
  success: boolean
  blockNumber: string
  timestamp: number
  entryPointVersion: string
  chainId: number
}

interface DeploymentEvent {
  id: string
  account: string
  factory: string
  entryPoint: string
  blockNumber: string
  timestamp: number
  paymaster: string | null
  entryPointVersion: string
  txHash: string
  blockHash: string
  chainId: number
}

interface SmartAccount {
  address: string
  chainId: number
  factory: string
  entryPointVersion: string
  deployedAt: number
  totalUserOps: number
  totalGasSpent: string
}

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000)
    return delay
  }
})

const client = new GraphQLClient(INDEXER_URL)

const USER_OPS_QUERY = gql`
  query GetRecentUserOps($since: BigInt!) {
    userOperations(
      where: { blockNumber_gt: $since }
      orderBy: "blockNumber"
      orderDirection: "asc"
      limit: 100
    ) {
      items {
        id
        txHash
        sender
        paymaster
        actualGasCost
        actualGasUsed
        success
        blockNumber
        timestamp
        entryPointVersion
        chainId
      }
    }
  }
`

const DEPLOYMENTS_QUERY = gql`
  query GetRecentDeployments($since: BigInt!) {
    accountDeployeds(
      where: { blockNumber_gt: $since }
      orderBy: "blockNumber"
      orderDirection: "asc"
      limit: 100
    ) {
      items {
        id
        account
        factory
        entryPoint
        blockNumber
        timestamp
        paymaster
        entryPointVersion
        txHash
        blockHash
        chainId
      }
    }
  }
`

const WALLET_QUERY = gql`
  query GetWallet($address: String!) {
    smartAccount(id: $address) {
      address
      chainId
      factory
      entryPointVersion
      deployedAt
      totalUserOps
      totalGasSpent
    }
  }
`

/**
 * Build watermark key matching indexer pattern.
 */
function watermarkKey(chainId: number, contract: string): string {
  return `${WATERMARK_PREFIX}:${chainId}:${contract}`
}

/**
 * Get the current watermark for a chain+contract.
 */
async function getWatermark(chainId: number = 369, contract: string = 'default'): Promise<string> {
  const wm = await redis.get(watermarkKey(chainId, contract))
  return wm || '0'
}

/**
 * Check if event should be notified (matches indexer's shouldNotify).
 */
async function shouldNotify(
  eventId: string,
  blockNumber: string,
  chainId: number = 369,
  contract: string = 'default'
): Promise<boolean> {
  const wmKey = watermarkKey(chainId, contract)
  const watermark = await redis.get(wmKey)
  
  if (watermark) {
    const bn = BigInt(blockNumber)
    const wm = BigInt(watermark)
    
    if (bn < wm) return false
    
    if (bn === wm) {
      const exists = await redis.exists(`${EVENT_PREFIX}${eventId}`)
      if (exists) return false
    }
  }
  
  await redis.set(`${EVENT_PREFIX}${eventId}`, '1', 'EX', EVENT_TTL)
  
  if (!watermark || BigInt(blockNumber) > BigInt(watermark)) {
    await redis.set(wmKey, blockNumber)
  }
  
  return true
}

async function fetchWallet(address: string): Promise<WalletState | null> {
  try {
    const data = await client.request(WALLET_QUERY, { address })
    const wallet = (data as any).smartAccount
    if (!wallet) return null
    
    return {
      address: wallet.address,
      chainId: wallet.chainId,
      factory: wallet.factory,
      entryPointVersion: wallet.entryPointVersion,
      deployedAt: BigInt(wallet.deployedAt),
      totalUserOps: wallet.totalUserOps,
      totalGasSpent: BigInt(wallet.totalGasSpent)
    }
  } catch {
    return null
  }
}

async function processUserOp(op: UserOpEvent) {
  const isNew = await shouldNotify(op.id, op.blockNumber, op.chainId, 'EntryPointV07')
  if (!isNew) {
    console.log(`[Skip] UserOp ${op.id} already notified`)
    return
  }

  // Fetch wallet state for summary
  const wallet = await fetchWallet(op.sender)

  const opInfo: UserOpInfo = {
    userOpHash: op.id,
    chainId: op.chainId,
    sender: op.sender,
    paymaster: op.paymaster || '0x0000000000000000000000000000000000000000',
    success: op.success,
    actualGasCost: BigInt(op.actualGasCost),
    actualGasUsed: BigInt(op.actualGasUsed),
    entryPointVersion: op.entryPointVersion,
    txHash: op.txHash,
    blockHash: '', // Not needed for display
    blockNumber: BigInt(op.blockNumber),
    timestamp: BigInt(op.timestamp)
  }

  await notifyUserOp(opInfo, wallet)
  console.log(`[UserOp] ${op.txHash} | ${op.sender} | ${Number(op.actualGasCost) / 1e18} PLS`)
}

async function processDeployment(deploy: DeploymentEvent) {
  const isNew = await shouldNotify(deploy.id, deploy.blockNumber, deploy.chainId, 'EntryPointV07')
  if (!isNew) {
    console.log(`[Skip] Deployment ${deploy.id} already notified`)
    return
  }

  const depInfo: DeployInfo = {
    userOpHash: deploy.id,
    chainId: deploy.chainId,
    account: deploy.account,
    factory: deploy.factory,
    paymaster: deploy.paymaster || '0x0000000000000000000000000000000000000000',
    entryPointVersion: deploy.entryPointVersion,
    txHash: deploy.txHash,
    blockHash: deploy.blockHash,
    blockNumber: BigInt(deploy.blockNumber),
    timestamp: BigInt(deploy.timestamp)
  }

  await notifyAccountDeployed(depInfo)
  console.log(`[Deploy] ${deploy.account} | Factory: ${deploy.factory}`)
}

async function fetchUserOps(since: string): Promise<UserOpEvent[]> {
  const data = await client.request(USER_OPS_QUERY, { since })
  return (data as any).userOperations?.items || []
}

async function fetchDeployments(since: string): Promise<DeploymentEvent[]> {
  const data = await client.request(DEPLOYMENTS_QUERY, { since })
  return (data as any).accountDeployeds?.items || []
}

async function poll() {
  try {
    const lastBlock = await getWatermark(369, 'EntryPointV07')
    
    const [ops, deployments] = await Promise.all([
      fetchUserOps(lastBlock),
      fetchDeployments(lastBlock)
    ])
    
    for (const op of ops) {
      await processUserOp(op)
    }
    
    for (const deploy of deployments) {
      await processDeployment(deploy)
    }
    
    if (ops.length === 0 && deployments.length === 0) {
      console.log(`[Poll] No new events since block ${lastBlock}`)
    }
  } catch (err) {
    console.error('[Poll Error]', err)
  }
}

async function main() {
  console.log('🔍 Belt UserOp Monitor starting...')
  console.log(`📊 Indexer: ${INDEXER_URL}`)
  console.log(`🔴 Redis: ${REDIS_URL}`)
  console.log(`⏱️  Poll interval: ${POLL_INTERVAL_MS}ms`)
  console.log('📡 Using indexer Redis keys (belt:notifications:*)')
  
  await redis.ping()
  console.log('✅ Redis connected')

  await poll()
  setInterval(poll, POLL_INTERVAL_MS)
  
  process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down...')
    await redis.quit()
    process.exit(0)
  })
}

main().catch(console.error)
