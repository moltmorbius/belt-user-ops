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

let lastCheckedBlock = '0'

async function fetchUserOps(): Promise<UserOpEvent[]> {
  const data = await client.request(USER_OPS_QUERY, { since: lastCheckedBlock })
  return (data as any).userOperations?.items || []
}

async function fetchDeployments(): Promise<DeploymentEvent[]> {
  const data = await client.request(DEPLOYMENTS_QUERY, { since: lastCheckedBlock })
  return (data as any).accountDeployeds?.items || []
}

async function postToDiscord(content?: string, embeds?: any[]) {
  if (!DISCORD_WEBHOOK) {
    console.log('[Discord]', content || embeds)
    return
  }
  
  await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, embeds })
  })
}

async function processUserOps(ops: UserOpEvent[]) {
  for (const op of ops) {
    const status = op.success ? '✅' : '❌'
    const gasCostPLS = Number(op.actualGasCost) / 1e18
    const paymasterText = op.paymaster ? `[\`${op.paymaster.slice(0, 6)}…${op.paymaster.slice(-4)}\`](https://scan.pulsechain.com/address/${op.paymaster})` : 'Self-sponsored'
    
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
  }
}

async function processDeployments(deployments: DeploymentEvent[]) {
  for (const deploy of deployments) {
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
      const maxBlock = ops.reduce((max, op) => Number(op.blockNumber) > Number(max) ? op.blockNumber : max, '0')
      if (Number(maxBlock) > Number(lastCheckedBlock)) lastCheckedBlock = maxBlock
    }
    
    if (deployments.length > 0) {
      await processDeployments(deployments)
      const maxBlock = deployments.reduce((max, d) => Number(d.blockNumber) > Number(max) ? d.blockNumber : max, '0')
      if (Number(maxBlock) > Number(lastCheckedBlock)) lastCheckedBlock = maxBlock
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
