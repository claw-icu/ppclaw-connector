const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = {
  name: 'ppclaw-connector',
  type: 'channel',

  async activate(context) {
    const config = context.config.channels.ppclaw;
    let apiKey = config.apiKey;
    let relays = [];
    let failedNodes = [];
    let retryDelay = 1000;

    // Get agent info
    const agentId = context.agent?.id || 'main';
    const agentName = context.agent?.name || config.agentName || 'Agent';

    // --- Notes storage ---
    const NOTES_DIR = path.join(os.homedir(), '.openclaw', 'agents', agentId, 'ppclaw-notes');

    // Ensure notes directory exists
    if (!fs.existsSync(NOTES_DIR)) {
      fs.mkdirSync(NOTES_DIR, { recursive: true });
    }

    // Sanitize groupId to prevent path traversal
    function sanitizeGroupId(groupId) {
      if (typeof groupId !== 'string' || !UUID_REGEX.test(groupId.trim())) {
        throw new Error('Invalid group ID format');
      }
      return groupId.trim().toLowerCase();
    }

    // Get safe notes path
    function getNotesPath(groupId) {
      const safeId = sanitizeGroupId(groupId);
      const notesPath = path.join(NOTES_DIR, `group-${safeId}.md`);
      const resolved = path.resolve(notesPath);
      if (!resolved.startsWith(path.resolve(NOTES_DIR))) {
        throw new Error('Invalid notes path');
      }
      return resolved;
    }

    // Read group notes
    function readGroupNotes(groupId) {
      try {
        const notesPath = getNotesPath(groupId);
        if (fs.existsSync(notesPath)) {
          return fs.readFileSync(notesPath, 'utf-8');
        }
      } catch (err) {
        console.error('[ppclaw] Error reading notes:', err.message);
      }
      return '';
    }

    // Write group notes
    function writeGroupNotes(groupId, content) {
      try {
        const notesPath = getNotesPath(groupId);
        // Limit notes size (100KB)
        if (content.length > 100 * 1024) {
          throw new Error('Notes content too large (max 100KB)');
        }
        fs.writeFileSync(notesPath, content, 'utf-8');
        return true;
      } catch (err) {
        console.error('[ppclaw] Error writing notes:', err.message);
        throw err;
      }
    }

    // Current group context for tool calls
    let currentGroupId = null;

    // Register update_group_notes tool if supported
    if (typeof context.registerTool === 'function') {
      context.registerTool({
        name: 'update_group_notes',
        description: 'Update the project notes for the current group. Use this to track tasks, decisions, and project status.',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The complete notes content in markdown format',
            },
          },
          required: ['content'],
        },
        handler: async ({ content }) => {
          if (!currentGroupId) {
            return { success: false, error: 'Not in a group context' };
          }
          try {
            writeGroupNotes(currentGroupId, content);
            return { success: true, message: 'Notes updated successfully' };
          } catch (err) {
            return { success: false, error: err.message };
          }
        },
      });
    }

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

        // Reset session
        if (msg.type === 'new_session') {
          context.agent.resetConversation();
          return;
        }

        // --- Direct message (1-on-1) ---
        if (msg.type === 'message') {
          ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
          currentGroupId = null; // Not in a group

          try {
            const reply = await context.agent.processMessage({
              content: msg.content,
              attachments: msg.attachments,
              channelId: 'ppclaw',
              messageId: msg.id,
              provider: 'ppclaw',
              metadata: {
                chatType: 'dm',
                selfId: agentId,
                selfName: agentName,
                senderId: msg.senderId,
                senderType: 'user',
                senderName: msg.senderName || 'User',
              },
            });

            ws.send(JSON.stringify({
              type: 'reply',
              replyTo: msg.id,
              content: reply.content,
              attachments: reply.attachments,
            }));
          } catch (err) {
            console.error('[ppclaw] Error processing message:', err.message);
            ws.send(JSON.stringify({
              type: 'reply',
              replyTo: msg.id,
              content: 'Sorry, an error occurred while processing your message.',
            }));
          }
        }

        // --- Group message ---
        if (msg.type === 'group_message') {
          ws.send(JSON.stringify({ type: 'ack', id: msg.id }));

          // Set current group for tool calls
          currentGroupId = msg.groupId;

          // Read group notes
          const groupNotes = readGroupNotes(msg.groupId);

          try {
            const reply = await context.agent.processMessage({
              content: msg.content,
              attachments: msg.attachments,
              channelId: 'ppclaw',
              messageId: msg.id,
              // Key: group session routing
              from: `ppclaw:group:${msg.groupId}`,
              chatType: 'group',
              provider: 'ppclaw',
              metadata: {
                chatType: 'group',
                selfId: agentId,
                selfName: agentName,
                groupId: msg.groupId,
                groupName: msg.groupName,
                senderId: msg.senderId,
                senderType: msg.senderType,
                senderName: msg.senderName,
                isMentioned: msg.isMentioned,
                groupContext: {
                  owner: msg.groupOwner,
                  agents: msg.groupAgents,
                },
                // Inject group notes
                groupNotes: groupNotes,
              },
            });

            ws.send(JSON.stringify({
              type: 'group_reply',
              replyTo: msg.id,
              groupId: msg.groupId,
              content: reply.content,
              attachments: reply.attachments,
            }));
          } catch (err) {
            console.error('[ppclaw] Error processing group message:', err.message);
            ws.send(JSON.stringify({
              type: 'group_reply',
              replyTo: msg.id,
              groupId: msg.groupId,
              content: 'Sorry, an error occurred while processing your message.',
            }));
          } finally {
            currentGroupId = null;
          }
        }

        // --- Bot-to-bot DM ---
        if (msg.type === 'bot_dm') {
          currentGroupId = null; // Not in a group

          try {
            const sessionKey = msg.taskId
              ? `ppclaw:task:${msg.taskId}:peer:${msg.fromAgentId}`
              : `ppclaw:dm:${msg.fromAgentId}`;

            const reply = await context.agent.processMessage({
              content: msg.content,
              channelId: 'ppclaw',
              messageId: msg.id,
              from: sessionKey,
              chatType: 'dm',
              provider: 'ppclaw',
              metadata: {
                chatType: 'bot_dm',
                selfId: agentId,
                selfName: agentName,
                fromAgentId: msg.fromAgentId,
                fromAgentName: msg.fromAgentName,
                senderType: 'agent',
                taskId: msg.taskId,
              },
            });

            ws.send(JSON.stringify({
              type: 'bot_dm_reply',
              replyTo: msg.id,
              targetAgentId: msg.fromAgentId,
              taskId: msg.taskId,
              content: reply.content,
            }));
          } catch (err) {
            console.error('[ppclaw] Error processing bot DM:', err.message);
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
