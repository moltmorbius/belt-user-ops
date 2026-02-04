#!/usr/bin/env tsx
/**
 * Belt UserOp Monitor
 * 
 * Independent notification service for Belt AA operations.
 * Uses the SAME Redis instance and key structure as belt-indexer.
 * 
 * Indexer tracks watermarks; this service reads them and sends Discord notifications.
 * Separation of concerns: Indexer indexes, Monitor notifies.
 */

import { GraphQLClient, gql } from 'graphql-request'
import Redis from 'ioredis'

const INDEXER_URL = process.env.BELT_INDEXER_URL || 'https://belt-indexer-production.up.railway.app/graphql'
const POLL_INTERVAL_MS = 10_000 // 10 seconds
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL
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
  success: boolean
  blockNumber: string
  timestamp: number
  entryPointVersion: string
}

interface DeploymentEvent {
  id: string
  account: string
  factory: string
  entryPoint: string
  blockNumber: string
  timestamp: number
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
        success
        blockNumber
        timestamp
        entryPointVersion
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
      }
    }
  }
`

/**
 * Build watermark key matching indexer pattern.
 * e.g. "belt:notifications:watermark:369:EntryPointV07"
 */
function watermarkKey(chainId: number, contract: string): string {
  return `${WATERMARK_PREFIX}:${chainId}:${contract}`
}

/**
 * Get the current watermark for a chain+contract.
 * This tells us what's already been notified.
 */
async function getWatermark(chainId: number = 369, contract: string = 'default'): Promise<string> {
  const wm = await redis.get(watermarkKey(chainId, contract))
  return wm || '0'
}

/**
 * Check if event should be notified.
 * Uses the SAME logic as the indexer's shouldNotify().
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
    
    // Below watermark - skip
    if (bn < wm) return false
    
    // Same block as watermark - check individual event
    if (bn === wm) {
      const exists = await redis.exists(`${EVENT_PREFIX}${eventId}`)
      if (exists) return false
    }
  }
  
  // Record this event
  await redis.set(`${EVENT_PREFIX}${eventId}`, '1', 'EX', EVENT_TTL)
  
  // Update watermark if newer
  if (!watermark || BigInt(blockNumber) > BigInt(watermark)) {
    await redis.set(wmKey, blockNumber)
  }
  
  return true
}

async function postToDiscord(content?: string, embeds?: any[]) {
  if (!DISCORD_WEBHOOK) {
    console.log('[Discord]', content || embeds)
    return
  }
  
  try {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        username: 'Belt UserOps Monitor',
        content, 
        embeds 
      })
    })
    
    if (!res.ok && res.status !== 429) {
      console.error(`[Discord] Webhook failed: ${res.status}`)
    }
  } catch (err) {
    console.error('[Discord Error]', err)
  }
}

function shortenAddr(addr: string): string {
  if (!addr || addr === '0x0000000000000000000000000000000000000000') return 'none'
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

async function processUserOp(op: UserOpEvent) {
  // Check if already notified (using indexer's pattern)
  const isNew = await shouldNotify(op.id, op.blockNumber, 369, 'EntryPointV07')
  if (!isNew) {
    console.log(`[Skip] UserOp ${op.id} already notified`)
    return
  }

  const status = op.success ? '✅' : '❌'
  const gasCostPLS = Number(op.actualGasCost) / 1e18
  const paymasterText = op.paymaster && op.paymaster !== '0x0000000000000000000000000000000000000000'
    ? `[\`${shortenAddr(op.paymaster)}\`](https://scan.pulsechain.com/address/${op.paymaster})` 
    : 'Self-sponsored'
  
  const embed = {
    title: `${status} UserOperation — PulseChain ${op.entryPointVersion || 'v0_7'}`,
    color: op.success ? 0x00cc66 : 0xff0000,
    timestamp: new Date(op.timestamp * 1000).toISOString(),
    fields: [
      { name: 'Chain', value: 'PulseChain (369)', inline: true },
      { name: 'Sender', value: `[\`${shortenAddr(op.sender)}\`](https://scan.pulsechain.com/address/${op.sender})`, inline: true },
      { name: 'Paymaster', value: paymasterText, inline: true },
      { name: 'Gas Cost', value: `${gasCostPLS.toFixed(4)} PLS`, inline: true },
      { name: 'Tx', value: `[\`${shortenAddr(op.txHash)}\`](https://scan.pulsechain.com/tx/${op.txHash})`, inline: true },
      { name: 'Block', value: op.blockNumber, inline: true },
      { name: 'EntryPoint', value: op.entryPointVersion || 'v0_7', inline: true }
    ],
    footer: { text: `UserOp ${shortenAddr(op.id)} | PulseChain` }
  }
  
  await postToDiscord(undefined, [embed])
  console.log(`[UserOp] ${op.txHash} | ${op.sender} | ${gasCostPLS.toFixed(6)} PLS | Success: ${op.success}`)
}

async function processDeployment(deploy: DeploymentEvent) {
  // Check if already notified (using indexer's pattern)
  const isNew = await shouldNotify(deploy.id, deploy.blockNumber, 369, 'EntryPointV07')
  if (!isNew) {
    console.log(`[Skip] Deployment ${deploy.id} already notified`)
    return
  }

  const embed = {
    title: '🎉 Account Deployed — PulseChain v0_7',
    color: 0x5865f2,
    timestamp: new Date(deploy.timestamp * 1000).toISOString(),
    fields: [
      { name: 'Chain', value: 'PulseChain (369)', inline: true },
      { name: 'Account', value: `[\`${shortenAddr(deploy.account)}\`](https://scan.pulsechain.com/address/${deploy.account})`, inline: true },
      { name: 'Factory', value: `[\`${shortenAddr(deploy.factory)}\`](https://scan.pulsechain.com/address/${deploy.factory})`, inline: true },
      { name: 'EntryPoint', value: `[\`${shortenAddr(deploy.entryPoint)}\`](https://scan.pulsechain.com/address/${deploy.entryPoint})`, inline: true },
      { name: 'Block', value: deploy.blockNumber, inline: true }
    ],
    footer: { text: `Account Deployment | PulseChain` }
  }
  
  await postToDiscord(undefined, [embed])
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
    // Read watermark from Redis (what indexer has already marked)
    const lastBlock = await getWatermark(369, 'EntryPointV07')
    
    const [ops, deployments] = await Promise.all([
      fetchUserOps(lastBlock),
      fetchDeployments(lastBlock)
    ])
    
    // Process all events
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
  
  // Wait for Redis connection
  await redis.ping()
  console.log('✅ Redis connected')

  // Initial poll
  await poll()
  
  // Continuous polling
  setInterval(poll, POLL_INTERVAL_MS)
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down...')
    await redis.quit()
    process.exit(0)
  })
}

main().catch(console.error)
