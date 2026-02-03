# belt-user-ops

Real-time monitoring and analytics for Belt ERC-4337 operations on PulseChain.

## What This Does

Monitors the [belt-indexer](https://github.com/moltmorbius/belt-indexer) GraphQL API and posts notifications to Discord (#belt-user-ops) when:

- New AA wallets are deployed
- UserOperations are submitted (with USD gas cost estimates)
- Significant profit/loss events occur
- Gas sponsorship milestones hit

## Structure

- `monitor.ts` — Main monitoring loop (queries indexer, posts to Discord)
- `types.ts` — TypeScript types for UserOp events, wallet deployments, etc.
- `utils/` — Pricing, formatting, Discord helpers
- `config.ts` — Indexer URL, Discord webhook, thresholds

## Usage

```bash
npm install
npm run monitor
```

Typically runs as a background process or cron job.

## Environment

- `BELT_INDEXER_URL` — GraphQL endpoint (defaults to production)
- `DISCORD_WEBHOOK_URL` — #belt-user-ops webhook
- `PRICE_API_KEY` — Optional: for real-time PLS/USD pricing

## Data Sources

- Belt Indexer (GraphQL): UserOps, deployments, account activity
- PulseChain RPC: gas prices, block data
- CoinGecko/DexScreener: PLS/USD pricing

## License

MIT
