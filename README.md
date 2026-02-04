# belt-user-ops

Real-time monitoring and analytics for Belt ERC-4337 operations on PulseChain.

## What This Does

**Independent notification service** that polls the [belt-indexer](https://github.com/moltmorbius/belt-indexer) GraphQL API and posts Discord notifications for:

- New AA wallet deployments
- UserOperations (with gas costs, paymaster info, etc.)

**Key Features:**
- ✅ Completely independent from indexer (no notification logic in indexer)
- ✅ Redis-based deduplication (prevents duplicate notifications)
- ✅ Cursor-based polling (only fetches new events)
- ✅ Rich Discord embeds with clickable links
- ✅ Graceful degradation (works without Redis)

## Structure

- `monitor.ts` — Main notification service (cursor-based polling, Redis deduplication, Discord embeds)

## Usage

### Local Development
```bash
npm install
npm run dev
```

### Production (Railway)

1. **Deploy to Railway:**
   - Connect your GitHub repository
   - Railway will auto-detect the nixpacks build
   - Set environment variables (see below)

2. **Add Redis (optional but recommended):**
   - In Railway: Add a Redis service to your project
   - Copy the Redis URL from the service variables

3. **Configure Environment Variables:**
   ```
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
   ```
   Optional (but recommended):
   ```
   REDIS_URL=${{Redis.REDIS_URL}}
   ```
   ```
   BELT_INDEXER_URL=https://belt-indexer-production.up.railway.app/graphql
   ```

4. **Deploy:**
   - Railway will automatically build and start the monitor
   - Restarts on crash (configured in `railway.toml`)

The service runs continuously and polls every 10 seconds using cursor-based pagination.

## Environment

**Required:**
- `DISCORD_WEBHOOK_URL` — Discord webhook for #belt-user-ops channel

**Optional:**
- `BELT_INDEXER_URL` — GraphQL endpoint (defaults to production)
- `REDIS_URL` — Redis connection string (recommended for production; prevents duplicate notifications)

## Data Sources

- Belt Indexer (GraphQL): UserOps, deployments, account activity
- PulseChain RPC: gas prices, block data
- CoinGecko/DexScreener: PLS/USD pricing

## License

MIT
