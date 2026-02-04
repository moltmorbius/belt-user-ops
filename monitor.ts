#!/usr/bin/env tsx
/**
 * Belt UserOp Monitor
 * 
 * Polls belt-indexer GraphQL API for new events using cursor-based pagination.
 * Posts notifications to Discord #belt-user-ops channel.
 * Uses Redis for deduplication and state tracking.
 * 
 * This is completely independent of the indexer - all notification logic lives here.
 */

import { GraphQLClient, gql } from 'graphql-request'
import Redis from 'ioredis'

const INDEXER_URL = process.env.BELT_INDEXER_URL || 'https://belt-indexer-production.up.railway.app/graphql'
const POLL_INTERVAL_MS = 10_000 // 10 seconds
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL
const REDIS_URL = process.env.REDIS_URL

interface UserOpEvent {
  id: string
  txHash: string
  sender: string
  paymaster: string | null
  actualGasCost: string
  success: boolean
  blockNumber: string
  timestamp: number
}

interface DeploymentEvent {
  id: string
  account: string
  factory: string
  entryPoint: string
  blockNumber: string
  timestamp: number
}

const redis = REDIS_URL ? new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000)
    return delay
  }
}) : null

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

async function getLastProcessedBlock(): Promise<string> {
  if (!redis) return '0'
  const block = await redis.get('belt-monitor:last-block')
  return block || '0'
}

async function setLastProcessedBlock(block: string): Promise<void> {
  if (!redis) return
  await redis.set('belt-monitor:last-block', block)
}

async function isAlreadyNotified(type: 'userop' | 'deployment', id: string): Promise<boolean> {
  if (!redis) return false
  const key = `notified:${type}:${id}`
  return (await redis.exists(key)) === 1
}

async function markAsNotified(type: 'userop' | 'deployment', id: string): Promise<void> {
  if (!redis) return
  const key = `notified:${type}:${id}`
  // Expire after 7 days
  await redis.set(key, '1', 'EX', 60 * 60 * 24 * 7)
}

async function postToDiscord(content?: string, embeds?: any[]) {
  if (!DISCORD_WEBHOOK) {
    console.log('[Discord]', content || embeds)
    return
  }
  
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, embeds })
    })
  } catch (err) {
    console.error('[Discord Error]', err)
  }
}

async function processUserOp(op: UserOpEvent) {
  // Check if already notified
  if (await isAlreadyNotified('userop', op.id)) {
    console.log(`[Skip] UserOp ${op.id} already notified`)
    return
  }

  const status = op.success ? '✅' : '❌'
  const gasCostPLS = Number(op.actualGasCost) / 1e18
  const paymasterText = op.paymaster 
    ? `[\`${op.paymaster.slice(0, 6)}…${op.paymaster.slice(-4)}\`](https://scan.pulsechain.com/address/${op.paymaster})` 
    : 'Self-sponsored'
  
  const embed = {
    title: `${status} UserOperation — PulseChain v0_7`,
    color: op.success ? 0x00cc66 : 0xff0000,
    timestamp: new Date(op.timestamp * 1000).toISOString(),
    fields: [
      { name: 'Chain', value: 'PulseChain (369)', inline: true },
      { name: 'Sender', value: `[\`${op.sender.slice(0, 6)}…${op.sender.slice(-4)}\`](https://scan.pulsechain.com/address/${op.sender})`, inline: true },
      { name: 'Paymaster', value: paymasterText, inline: true },
      { name: 'Gas Cost', value: `${gasCostPLS.toFixed(4)} PLS`, inline: true },
      { name: 'Tx', value: `[\`${op.txHash.slice(0, 6)}…${op.txHash.slice(-4)}\`](https://scan.pulsechain.com/tx/${op.txHash})`, inline: true },
      { name: 'Block', value: op.blockNumber, inline: true },
      { name: 'EntryPoint', value: 'v0_7', inline: true }
    ],
    footer: { text: `UserOp ${op.id.slice(0, 6)}…${op.id.slice(-4)} | PulseChain` }
  }
  
  await postToDiscord(undefined, [embed])
  console.log(`[UserOp] ${op.txHash} | ${op.sender} | ${gasCostPLS.toFixed(6)} PLS | Success: ${op.success}`)
  
  // Mark as notified
  await markAsNotified('userop', op.id)
}

async function processDeployment(deploy: DeploymentEvent) {
  // Check if already notified
  if (await isAlreadyNotified('deployment', deploy.id)) {
    console.log(`[Skip] Deployment ${deploy.id} already notified`)
    return
  }

  const embed = {
    title: '🎉 Account Deployed — PulseChain v0_7',
    color: 0x5865f2,
    timestamp: new Date(deploy.timestamp * 1000).toISOString(),
    fields: [
      { name: 'Chain', value: 'PulseChain (369)', inline: true },
      { name: 'Account', value: `[\`${deploy.account.slice(0, 6)}…${deploy.account.slice(-4)}\`](https://scan.pulsechain.com/address/${deploy.account})`, inline: true },
      { name: 'Factory', value: `[\`${deploy.factory.slice(0, 6)}…${deploy.factory.slice(-4)}\`](https://scan.pulsechain.com/address/${deploy.factory})`, inline: true },
      { name: 'EntryPoint', value: `[\`${deploy.entryPoint.slice(0, 6)}…${deploy.entryPoint.slice(-4)}\`](https://scan.pulsechain.com/address/${deploy.entryPoint})`, inline: true },
      { name: 'Block', value: deploy.blockNumber, inline: true }
    ],
    footer: { text: `Account Deployment | PulseChain` }
  }
  
  await postToDiscord(undefined, [embed])
  console.log(`[Deploy] ${deploy.account} | Factory: ${deploy.factory}`)
  
  // Mark as notified
  await markAsNotified('deployment', deploy.id)
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
    const lastBlock = await getLastProcessedBlock()
    
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
    
    // Update last processed block
    const allEvents = [...ops, ...deployments]
    if (allEvents.length > 0) {
      const maxBlock = allEvents.reduce((max, evt) => {
        const evtBlock = Number(evt.blockNumber)
        return evtBlock > Number(max) ? evt.blockNumber : max
      }, lastBlock)
      
      if (Number(maxBlock) > Number(lastBlock)) {
        await setLastProcessedBlock(maxBlock)
        console.log(`[State] Updated last block to ${maxBlock}`)
      }
    } else {
      console.log(`[Poll] No new events since block ${lastBlock}`)
    }
  } catch (err) {
    console.error('[Poll Error]', err)
  }
}

async function main() {
  console.log('🔍 Belt UserOp Monitor starting...')
  console.log(`📊 Indexer: ${INDEXER_URL}`)
  console.log(`🔴 Redis: ${REDIS_URL || 'disabled (no deduplication)'}`)
  console.log(`⏱️  Poll interval: ${POLL_INTERVAL_MS}ms`)
  
  // Wait for Redis connection if enabled
  if (redis) {
    await redis.ping()
    console.log('✅ Redis connected')
  }

  // Initial poll
  await poll()
  
  // Continuous polling
  setInterval(poll, POLL_INTERVAL_MS)
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down...')
    if (redis) await redis.quit()
    process.exit(0)
  })
}

main().catch(console.error)
