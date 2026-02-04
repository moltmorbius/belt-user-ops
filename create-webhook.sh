#!/bin/bash
# Discord webhook creation
# Requires DISCORD_BOT_TOKEN env var

CHANNEL_ID="1467912858259034425"
WEBHOOK_NAME="Belt UserOps Monitor"

curl -X POST "https://discord.com/api/v10/channels/${CHANNEL_ID}/webhooks" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"${WEBHOOK_NAME}\"}" 2>&1
