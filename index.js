const WebSocket = require('ws');

module.exports = {
  name: 'ppclaw-connector',
  type: 'channel',

  async activate(context) {
    const config = context.config.channels.ppclaw;
    let apiKey = config.apiKey;
    let relays = [];
    let failedNodes = [];
    let retryDelay = 1000;

    // Fetch relay.json from discovery URL
    async function fetchRelays() {
      const discoveryUrl = config.discoveryUrl || 'https://api.claw.icu/relay.json';
      const res = await fetch(discoveryUrl);
      const data = await res.json();
      relays = data.relays;
    }

    // Weighted random selection, excluding recently failed nodes
    function pickRelay() {
      const available = relays.filter((r) => !failedNodes.includes(r.id));
      if (available.length === 0) {
        failedNodes = []; // All failed — reset and retry from full list
        return relays[0];
      }
      const totalWeight = available.reduce((s, r) => s + r.weight, 0);
      let rand = Math.random() * totalWeight;
      for (const r of available) {
        rand -= r.weight;
        if (rand <= 0) return r;
      }
      return available[0];
    }

    // Initial relay discovery
    await fetchRelays();

    // First-time binding: exchange bindToken for apiKey
    if (!apiKey && config.bindToken) {
      const relay = pickRelay();
      const baseUrl = relay.ws
        .replace('wss://', 'https://')
        .replace('ws://', 'http://')
        .replace(/\/ws\/?$/, '');
      const res = await fetch(`${baseUrl}/api/agent/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: config.bindToken }),
      });
      const data = await res.json();
      if (!data.api_key) {
        throw new Error(`Binding failed: ${JSON.stringify(data)}`);
      }
      apiKey = data.api_key;
      // Persist: replace bindToken with apiKey
      context.updateConfig({
        channels: { ppclaw: { apiKey, bindToken: undefined } },
      });
    }

    if (!apiKey) {
      throw new Error('No apiKey and no bindToken configured for ppclaw');
    }

    // Establish WebSocket connection with failover
    async function connect() {
      try {
        await fetchRelays();
      } catch (err) {
        console.error('[ppclaw] Failed to fetch relay.json:', err.message);
        // Use cached relays if available
        if (relays.length === 0) {
          setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30000);
          return;
        }
      }

      const relay = pickRelay();
      if (!relay) {
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
        return;
      }

      console.log(`[ppclaw] Connecting to ${relay.id} (${relay.ws}/agent)`);

      const ws = new WebSocket(`${relay.ws}/agent`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      ws.on('open', () => {
        console.log(`[ppclaw] Connected to ${relay.id}`);
        retryDelay = 1000; // Reset backoff
        failedNodes = failedNodes.filter((id) => id !== relay.id);
      });

      ws.on('message', async (data) => {
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }

        // Respond to server pings
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (msg.type === 'new_session') {
          context.agent.resetConversation();
          return;
        }

        if (msg.type === 'message') {
          // Acknowledge receipt immediately
          ws.send(JSON.stringify({ type: 'ack', id: msg.id }));

          try {
            const reply = await context.agent.processMessage({
              content: msg.content,
              attachments: msg.attachments,
              channelId: 'ppclaw',
              messageId: msg.id,
            });

            ws.send(
              JSON.stringify({
                type: 'reply',
                replyTo: msg.id,
                content: reply.content,
                attachments: reply.attachments,
              })
            );
          } catch (err) {
            console.error('[ppclaw] Error processing message:', err.message);
            ws.send(
              JSON.stringify({
                type: 'reply',
                replyTo: msg.id,
                content: 'Sorry, an error occurred while processing your message.',
              })
            );
          }
        }
      });

      ws.on('close', () => {
        console.log(`[ppclaw] Disconnected from ${relay.id}, reconnecting...`);
        failedNodes.push(relay.id);
        retryDelay = Math.min(retryDelay * 2, 30000);
        setTimeout(connect, retryDelay);
      });

      ws.on('error', (err) => {
        console.error(`[ppclaw] WebSocket error:`, err.message);
      });
    }

    connect();
  },
};
