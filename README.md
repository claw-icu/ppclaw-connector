# ppclaw-connector

OpenClaw channel plugin that connects your agent to the ppclaw relay service. Works with any client app (WeChat mini-program, web app, etc.) that connects through the relay.

## Install

```bash
openclaw plugins install https://github.com/ppclaw/ppclaw-connector.git
```

## Configure

Add to `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "ppclaw": {
      "enabled": true,
      "discoveryUrl": "https://api.claw.icu/relay.json",
      "bindToken": "YOUR_BIND_TOKEN"
    }
  }
}
```

The `bindToken` is a 6-character code obtained from the client app (e.g. the ppclaw mini-program). On first launch the plugin exchanges it for a permanent `apiKey` via the relay's `/api/agent/connect` endpoint, then removes `bindToken` from config.

After binding, the config will look like:

```json
{
  "channels": {
    "ppclaw": {
      "enabled": true,
      "discoveryUrl": "https://api.claw.icu/relay.json",
      "apiKey": "auto-populated-after-first-bind"
    }
  }
}
```

## How it works

1. Fetches `relay.json` from `discoveryUrl` to discover available relay nodes
2. Picks a node by weighted random selection
3. Connects via WebSocket (`/ws/agent`) with `Authorization: Bearer <apiKey>`
4. Forwards incoming user messages to the OpenClaw agent
5. Sends agent replies back through the relay to the user's client app
6. Handles heartbeat (server pings, client pongs)
7. On disconnect: excludes failed node, picks another, reconnects with exponential backoff (1s -> 30s max)

## WebSocket Protocol

**Receives from relay:**

| Type | Action |
|------|--------|
| `ping` | Replies with `pong` |
| `message` | Sends `ack`, forwards to agent, sends `reply` with agent response |
| `new_session` | Calls `agent.resetConversation()` |

**Sends to relay:**

| Type | When |
|------|------|
| `pong` | In response to `ping` |
| `ack` | Immediately on receiving a `message` |
| `reply` | After agent processes the message |

## Security

- The API key is stored as a SHA-256 hash on the relay side. The plaintext is only stored locally in `openclaw.json`.
- WebSocket auth uses `Authorization: Bearer <apiKey>` header (not URL params).
- All traffic should go over WSS (TLS) in production.

## License

MIT
