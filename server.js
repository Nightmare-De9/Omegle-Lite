import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// In-memory state (reset on restart)
const clients = new Map(); // id -> { ws, mode, interests:Set, roomId, queuedAt }
const waiting = { text: new Set(), video: new Set() }; // sets of client ids
const recentPairs = new Map(); // key `${a}|${b}` -> ts (avoid immediate re-pair)

const now = () => Date.now();
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = (Math.random() * 16) | 0; const v = c === 'x' ? r : (r & 0x3 | 0x8); return v.toString(16);
});

function send(ws, msg) {
  try { ws.send(JSON.stringify(msg)); } catch {}
}

function toSet(a) { return new Set((a || []).filter(Boolean).map(s => s.toLowerCase())); }
function overlap(a, b) { for (const x of a) if (b.has(x)) return true; return false; }
function pairKey(a, b) { return [a, b].sort().join('|'); }

function enqueue(id) {
  const c = clients.get(id);
  if (!c) return;
  if (!['text', 'video'].includes(c.mode)) return;
  c.queuedAt = now();
  waiting[c.mode].add(id);
}

function dequeue(id) {
  waiting.text.delete(id);
  waiting.video.delete(id);
}

function leaveRoom(id, reason = 'left') {
  const c = clients.get(id);
  if (!c || !c.roomId) return;
  const roomId = c.roomId;
  c.roomId = null;
  // Notify partner
  for (const [otherId, oc] of clients) {
    if (otherId !== id && oc.roomId === roomId) {
      oc.roomId = null;
      send(oc.ws, { event: 'partner_left', reason });
    }
  }
}

function tryMatch(mode) {
  const ids = Array.from(waiting[mode]);
  if (ids.length < 2) return;

  // naive O(n^2) scan with small friendliness rules; good enough for demo
  ids.sort((a, b) => (clients.get(a)?.queuedAt || 0) - (clients.get(b)?.queuedAt || 0));

  for (let i = 0; i < ids.length; i++) {
    const aId = ids[i]; const A = clients.get(aId); if (!A) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const bId = ids[j]; const B = clients.get(bId); if (!B) continue;
      if (A.mode !== B.mode) continue;
      if (A.roomId || B.roomId) continue;
      // avoid instant re-pairs
      const k = pairKey(aId, bId);
      if ((now() - (recentPairs.get(k) || 0)) < 15_000) continue;
      // prefer interest overlap in first 5s
      const waitA = now() - (A.queuedAt || 0);
      const waitB = now() - (B.queuedAt || 0);
      const needOverlap = Math.min(waitA, waitB) < 5000;
      if (needOverlap && A.interests.size && B.interests.size && !overlap(A.interests, B.interests)) continue;

      // match them
      const roomId = uuid();
      dequeue(aId); dequeue(bId);
      A.roomId = roomId; B.roomId = roomId;
      recentPairs.set(k, now());
      send(A.ws, { event: 'paired', room_id: roomId, partner_id: bId, mode });
      send(B.ws, { event: 'paired', room_id: roomId, partner_id: aId, mode });
      return; // one pair per tick
    }
  }
}

function broadcastToRoom(roomId, msg, exceptId = null) {
  for (const [id, c] of clients) {
    if (c.roomId === roomId && id !== exceptId) send(c.ws, msg);
  }
}

wss.on('connection', (ws) => {
  const id = uuid();
  clients.set(id, { ws, mode: 'text', interests: new Set(), roomId: null, queuedAt: 0 });
  send(ws, { event: 'hello', id });

  ws.on('message', (data) => {
    let msg = {};
    try { msg = JSON.parse(data.toString()); } catch {}

    const c = clients.get(id);
    if (!c) return;

    if (msg.cmd === 'match') {
      leaveRoom(id);
      c.mode = msg.mode === 'video' ? 'video' : 'text';
      c.interests = toSet(msg.interests);
      dequeue(id);
      enqueue(id);
      send(ws, { event: 'queued', est_wait_ms: 1200 });
      // small async to let both enqueue
      setTimeout(() => tryMatch(c.mode), 50);
    }

    else if (msg.cmd === 'cancel') {
      dequeue(id);
      send(ws, { event: 'unqueued' });
    }

    else if (msg.cmd === 'leave') {
      leaveRoom(id, msg.reason || 'left');
      enqueue(id); // auto requeue if you want; or comment out
      tryMatch(c.mode);
    }

    else if (msg.cmd === 'text' && c.roomId) {
      broadcastToRoom(c.roomId, { event: 'text', from: id, body: (msg.body || '').toString().slice(0, 2000) }, id);
    }

    // WebRTC signaling relay
    else if (msg.cmd === 'signal' && c.roomId) {
      broadcastToRoom(c.roomId, { event: 'signal', from: id, data: msg.data }, id);
    }
  });

  ws.on('close', () => {
    const c = clients.get(id);
    if (c) {
      leaveRoom(id, 'disconnect');
      dequeue(id);
      clients.delete(id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
