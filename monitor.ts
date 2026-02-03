#!/usr/bin/env tsx
/**
 * Belt UserOp Monitor
 * 
 * Polls the belt-indexer GraphQL API for new UserOperations and wallet deployments.
 * Posts notifications to Discord #belt-user-ops channel.
 */

import { GraphQLClient, gql } from 'graphql-request'

const INDEXER_URL = process.env.BELT_INDEXER_URL || 'https://belt-indexer-production.up.railway.app/sql'
const POLL_INTERVAL_MS = 15_000 // 15 seconds
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL

interface UserOpEvent {
  id: string
  userOpHash: string
  sender: string
  paymaster: string | null
  actualGasCost: bigint
  success: boolean
  blockNumber: bigint
  timestamp: number
}

interface DeploymentEvent {
  id: string
  account: string
  factory: string
  entryPoint: string
  blockNumber: bigint
  timestamp: number
}

const client = new GraphQLClient(INDEXER_URL)

const USER_OPS_QUERY = gql`
  query GetRecentUserOps($since: BigInt!) {
    userOperations(
      where: { blockNumber_gt: $since }
      orderBy: blockNumber
      orderDirection: asc
      first: 100
    ) {
      id
      userOpHash
      sender
      paymaster
      actualGasCost
      success
      blockNumber
      timestamp
    }
  }
`

const DEPLOYMENTS_QUERY = gql`
  query GetRecentDeployments($since: BigInt!) {
    accountDeployments(
      where: { blockNumber_gt: $since }
      orderBy: blockNumber
      orderDirection: asc
      first: 100
    ) {
      id
      account
      factory
      entryPoint
      blockNumber
      timestamp
    }
  }
`

let lastCheckedBlock = BigInt(0)

async function fetchUserOps(): Promise<UserOpEvent[]> {
  const data = await client.request(USER_OPS_QUERY, { since: lastCheckedBlock.toString() })
  return (data as any).userOperations || []
}

async function fetchDeployments(): Promise<DeploymentEvent[]> {
  const data = await client.request(DEPLOYMENTS_QUERY, { since: lastCheckedBlock.toString() })
  return (data as any).accountDeployments || []
}

async function postToDiscord(message: string) {
  if (!DISCORD_WEBHOOK) {
    console.log('[Discord]', message)
    return
  }
  
  await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: message })
  })
}

async function processUserOps(ops: UserOpEvent[]) {
  for (const op of ops) {
    const status = op.success ? '✅' : '❌'
    const gasCostPLS = Number(op.actualGasCost) / 1e18
    const sponsored = op.paymaster ? ' (sponsored)' : ''
    
    await postToDiscord(
      `${status} UserOp: \`${op.sender.slice(0, 10)}...\` | Gas: ${gasCostPLS.toFixed(6)} PLS${sponsored}`
    )
    
    console.log(`[UserOp] ${op.userOpHash} | ${op.sender} | ${gasCostPLS.toFixed(6)} PLS | Success: ${op.success}`)
  }
}

async function processDeployments(deployments: DeploymentEvent[]) {
  for (const deploy of deployments) {
    await postToDiscord(
      `🎉 New AA Wallet: \`${deploy.account}\` via \`${deploy.factory.slice(0, 10)}...\``
    )
    
    console.log(`[Deploy] ${deploy.account} | Factory: ${deploy.factory}`)
  }
}

async function poll() {
  try {
    const [ops, deployments] = await Promise.all([
      fetchUserOps(),
      fetchDeployments()
    ])
    
    if (ops.length > 0) {
      await processUserOps(ops)
      const maxBlock = ops.reduce((max, op) => op.blockNumber > max ? op.blockNumber : max, BigInt(0))
      if (maxBlock > lastCheckedBlock) lastCheckedBlock = maxBlock
    }
    
    if (deployments.length > 0) {
      await processDeployments(deployments)
      const maxBlock = deployments.reduce((max, d) => d.blockNumber > max ? d.blockNumber : max, BigInt(0))
      if (maxBlock > lastCheckedBlock) lastCheckedBlock = maxBlock
    }
    
    if (ops.length === 0 && deployments.length === 0) {
      console.log(`[Poll] No new events since block ${lastCheckedBlock}`)
    }
  } catch (err) {
    console.error('[Poll Error]', err)
  }
}

async function main() {
  console.log('🔍 Belt UserOp Monitor starting...')
  console.log(`📊 Indexer: ${INDEXER_URL}`)
  console.log(`⏱️  Poll interval: ${POLL_INTERVAL_MS}ms`)
  
  // Initial poll
  await poll()
  
  // Continuous polling
  setInterval(poll, POLL_INTERVAL_MS)
}

main().catch(console.error)
