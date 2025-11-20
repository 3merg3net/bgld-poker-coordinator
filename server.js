// server.js
require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// In-memory state (fine for testnet + small alpha)
const clients = new Map(); // ws -> { id, address, tableId }
const tables = new Map();  // tableId -> { id, players: Map<playerId, { id, address }> }

function log(...args) {
  console.log('[COORDINATOR]', ...args);
}

// Create HTTP server (Railway will hit this)
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Base Gold Rush Poker Coordinator is running.\n');
});

// Create WebSocket server on top
const wss = new WebSocket.Server({ server });

/**
 * Broadcast a message to all players at a given table.
 */
function broadcastToTable(tableId, message) {
  const table = tables.get(tableId);
  if (!table) return;

  const payload = typeof message === 'string' ? message : JSON.stringify(message);

  for (const [ws, client] of clients.entries()) {
    if (client.tableId === tableId && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

/**
 * Build a sanitized table state we can send to clients.
 */
function getTableState(tableId) {
  const table = tables.get(tableId);
  if (!table) return null;

  const players = Array.from(table.players.values()).map(p => ({
    id: p.id,
    address: p.address,
  }));

  return {
    tableId: table.id,
    players,
  };
}

/**
 * When a client connects via WebSocket
 */
wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGIN !== '*' && origin && origin !== ALLOWED_ORIGIN) {
    log('Rejected connection from origin:', origin);
    ws.close();
    return;
  }

  const clientId = `player-${Math.random().toString(36).slice(2, 10)}`;
  clients.set(ws, { id: clientId, address: null, tableId: null });

  log(`Client connected: ${clientId}`);

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      log('Bad JSON from client', err);
      return;
    }

    const client = clients.get(ws);
    if (!client) return;

    switch (msg.type) {
      case 'HELLO': {
        // { type: 'HELLO', address: '0x...' }
        client.address = msg.address || null;
        log(`HELLO from ${client.id} (${client.address || 'no address'})`);
        ws.send(JSON.stringify({
          type: 'WELCOME',
          playerId: client.id,
        }));
        break;
      }

      case 'JOIN_TABLE': {
        // { type: 'JOIN_TABLE', tableId: 'poker-1' }
        const tableId = msg.tableId || 'default';
        client.tableId = tableId;

        let table = tables.get(tableId);
        if (!table) {
          table = { id: tableId, players: new Map() };
          tables.set(tableId, table);
        }

        table.players.set(client.id, {
          id: client.id,
          address: client.address,
        });

        log(`Client ${client.id} joined table ${tableId}`);

        // Notify this player
        ws.send(JSON.stringify({
          type: 'TABLE_JOINED',
          tableId,
          playerId: client.id,
          state: getTableState(tableId),
        }));

        // Notify others at that table
        broadcastToTable(tableId, {
          type: 'TABLE_STATE',
          tableId,
          state: getTableState(tableId),
        });

        break;
      }

      case 'LEAVE_TABLE': {
        const { tableId } = client;
        if (!tableId) break;

        const table = tables.get(tableId);
        if (table) {
          table.players.delete(client.id);
          if (table.players.size === 0) {
            tables.delete(tableId);
          } else {
            broadcastToTable(tableId, {
              type: 'TABLE_STATE',
              tableId,
              state: getTableState(tableId),
            });
          }
        }
        client.tableId = null;
        ws.send(JSON.stringify({ type: 'LEFT_TABLE', tableId }));
        break;
      }

      case 'PLAYER_ACTION': {
        // generic action you can use later for bets, folds, etc.
        // { type: 'PLAYER_ACTION', tableId, action: 'BET', payload: {...} }
        const { tableId, action, payload } = msg;
        if (!tableId || !action) return;

        const table = tables.get(tableId);
        if (!table) return;

        // For now, just broadcast the action to everyone at the table
        broadcastToTable(tableId, {
          type: 'PLAYER_ACTION',
          tableId,
          from: client.id,
          action,
          payload,
        });

        break;
      }

      case 'PING': {
        ws.send(JSON.stringify({ type: 'PONG', now: Date.now() }));
        break;
      }

      default:
        log('Unknown message type:', msg.type);
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (!client) return;

    const { tableId, id } = client;

    if (tableId) {
      const table = tables.get(tableId);
      if (table) {
        table.players.delete(id);
        if (table.players.size === 0) {
          tables.delete(tableId);
        } else {
          broadcastToTable(tableId, {
            type: 'TABLE_STATE',
            tableId,
            state: getTableState(tableId),
          });
        }
      }
    }

    clients.delete(ws);
    log(`Client disconnected: ${id}`);
  });

  ws.on('error', (err) => {
    log('WebSocket error:', err);
  });
});

server.listen(PORT, () => {
  log(`Server listening on port ${PORT}`);
});
