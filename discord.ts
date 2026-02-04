/**
 * Discord Notification Module (lifted from belt-indexer)
 * 
 * Posts real-time notifications to Discord when Belt AA events are indexed.
 * Now running independently of the indexer.
 */

const EXPLORER = "https://scan.pulsechain.com";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortenAddr(addr: string): string {
  if (!addr || addr === "0x0000000000000000000000000000000000000000")
    return "none";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatGas(wei: bigint, currency: string = "PLS"): string {
  const eth = Number(wei) / 1e18;
  if (eth < 0.001) return `${(eth * 1e6).toFixed(2)} μ${currency}`;
  if (eth < 1) return `${eth.toFixed(6)} ${currency}`;
  return `${eth.toFixed(4)} ${currency}`;
}

function formatTimestamp(ts: bigint): string {
  return new Date(Number(ts) * 1000).toISOString();
}

function timeSince(deployTs: bigint, nowTs: bigint): string {
  const diff = Number(nowTs - deployTs);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

// ---------------------------------------------------------------------------
// Embed builders
// ---------------------------------------------------------------------------

/** Chain metadata for display */
const CHAIN_META: Record<number, { name: string; explorer: string; currency: string }> = {
  369: { name: "PulseChain", explorer: "https://scan.pulsechain.com", currency: "PLS" },
  1: { name: "Ethereum", explorer: "https://etherscan.io", currency: "ETH" },
};

function getChainMeta(chainId: number) {
  return CHAIN_META[chainId] ?? { name: `Chain ${chainId}`, explorer: EXPLORER, currency: "ETH" };
}

export interface WalletState {
  address: string;
  chainId: number;
  factory: string;
  entryPointVersion: string;
  deployedAt: bigint;
  totalUserOps: number;
  totalGasSpent: bigint;
}

export interface UserOpInfo {
  userOpHash: string;
  chainId: number;
  sender: string;
  paymaster: string;
  success: boolean;
  actualGasCost: bigint;
  actualGasUsed: bigint;
  entryPointVersion: string;
  txHash: string;
  blockHash: string;
  blockNumber: bigint;
  timestamp: bigint;
}

export interface DeployInfo {
  userOpHash: string;
  chainId: number;
  account: string;
  factory: string;
  paymaster: string;
  entryPointVersion: string;
  txHash: string;
  blockHash: string;
  blockNumber: bigint;
  timestamp: bigint;
}

function buildUserOpEmbed(op: UserOpInfo, wallet: WalletState | null) {
  const statusEmoji = op.success ? "✅" : "❌";
  const chain = getChainMeta(op.chainId);
  const fields = [
    {
      name: "Chain",
      value: `${chain.name} (${op.chainId})`,
      inline: true,
    },
    {
      name: "Sender",
      value: `[\`${shortenAddr(op.sender)}\`](${chain.explorer}/address/${op.sender})`,
      inline: true,
    },
    {
      name: "Paymaster",
      value:
        op.paymaster === "0x0000000000000000000000000000000000000000"
          ? "Self-sponsored"
          : `[\`${shortenAddr(op.paymaster)}\`](${chain.explorer}/address/${op.paymaster})`,
      inline: true,
    },
    {
      name: "Gas Cost",
      value: formatGas(op.actualGasCost, chain.currency),
      inline: true,
    },
    {
      name: "Tx",
      value: `[\`${shortenAddr(op.txHash)}\`](${chain.explorer}/tx/${op.txHash})`,
      inline: true,
    },
    {
      name: "Block",
      value: `${op.blockNumber}`,
      inline: true,
    },
    {
      name: "EntryPoint",
      value: op.entryPointVersion,
      inline: true,
    },
  ];

  // Add wallet state summary if we have it
  if (wallet) {
    const age = timeSince(wallet.deployedAt, op.timestamp);
    fields.push({
      name: "📊 Wallet Summary",
      value: [
        `**Total Ops:** ${wallet.totalUserOps}`,
        `**Total Gas:** ${formatGas(wallet.totalGasSpent, chain.currency)}`,
        `**Account Age:** ${age}`,
        `**Factory:** ${wallet.entryPointVersion}`,
      ].join(" • "),
      inline: false,
    });
  }

  return {
    title: `${statusEmoji} UserOperation — ${chain.name} ${op.entryPointVersion}`,
    color: op.success ? 0x00cc66 : 0xff3333,
    fields,
    timestamp: formatTimestamp(op.timestamp),
    footer: { text: `UserOp ${shortenAddr(op.userOpHash)} | ${chain.name}` },
  };
}

function buildDeployEmbed(dep: DeployInfo) {
  const chain = getChainMeta(dep.chainId);
  return {
    title: `🚀 New Account Deployed — ${chain.name} ${dep.entryPointVersion}`,
    color: 0x5865f2,
    description: `A new Belt smart account has been created on ${chain.name}.`,
    fields: [
      {
        name: "Chain",
        value: `${chain.name} (${dep.chainId})`,
        inline: true,
      },
      {
        name: "Account",
        value: `[\`${dep.account}\`](${chain.explorer}/address/${dep.account})`,
        inline: false,
      },
      {
        name: "Factory",
        value: `[\`${shortenAddr(dep.factory)}\`](${chain.explorer}/address/${dep.factory})`,
        inline: true,
      },
      {
        name: "Paymaster",
        value:
          dep.paymaster === "0x0000000000000000000000000000000000000000"
            ? "Self-sponsored"
            : `[\`${shortenAddr(dep.paymaster)}\`](${chain.explorer}/address/${dep.paymaster})`,
        inline: true,
      },
      {
        name: "EntryPoint",
        value: dep.entryPointVersion,
        inline: true,
      },
      {
        name: "Tx",
        value: `[\`${shortenAddr(dep.txHash)}\`](${chain.explorer}/tx/${dep.txHash})`,
        inline: true,
      },
      {
        name: "Block",
        value: `${dep.blockNumber}`,
        inline: true,
      },
    ],
    timestamp: formatTimestamp(dep.timestamp),
    footer: { text: `Deploy ${shortenAddr(dep.userOpHash)} | ${chain.name}` },
  };
}

// ---------------------------------------------------------------------------
// Send to Discord (with rate limiting)
// ---------------------------------------------------------------------------

/** Simple queue to avoid Discord 429s. Max 1 request per 2 seconds. */
let lastSendTime = 0;
const MIN_INTERVAL_MS = 2000;
const sendQueue: Array<{ embeds: any[]; resolve: (v: boolean) => void }> = [];
let processing = false;

async function processSendQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  while (sendQueue.length > 0) {
    const item = sendQueue.shift()!;
    const now = Date.now();
    const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastSendTime));
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }

    const result = await doSendWebhook(item.embeds);
    lastSendTime = Date.now();
    item.resolve(result);
  }

  processing = false;
}

async function doSendWebhook(embeds: any[]): Promise<boolean> {
  if (!DISCORD_WEBHOOK_URL || embeds.length === 0) return false;

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Belt Indexer",
        embeds,
      }),
    });

    if (res.status === 429) {
      // Rate limited — wait and retry once
      const retryAfter = Number(res.headers.get("retry-after") || "5") * 1000;
      console.warn(`Discord rate limited, retrying in ${retryAfter}ms`);
      await new Promise((r) => setTimeout(r, retryAfter));
      const retry = await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "Belt Indexer", embeds }),
      });
      if (!retry.ok) {
        console.error(`Discord webhook retry failed: ${retry.status}`);
        return false;
      }
      return true;
    }

    if (!res.ok) {
      console.error(`Discord webhook failed: ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Discord webhook error:", err);
    return false;
  }
}

async function sendWebhook(embeds: any[]): Promise<boolean> {
  return new Promise((resolve) => {
    sendQueue.push({ embeds, resolve });
    processSendQueue();
  });
}

// ---------------------------------------------------------------------------
// Public API — called from monitor
// ---------------------------------------------------------------------------

export async function notifyUserOp(
  op: UserOpInfo,
  wallet: WalletState | null,
): Promise<boolean> {
  const embed = buildUserOpEmbed(op, wallet);
  return sendWebhook([embed]);
}

export async function notifyAccountDeployed(
  dep: DeployInfo,
): Promise<boolean> {
  const embed = buildDeployEmbed(dep);
  return sendWebhook([embed]);
}
