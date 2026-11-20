const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room, send } = require('./src/room');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/health') return res.end('ok');
  if (url === '/') url = '/index.html';
  let file;
  try {
    file = path.join(PUBLIC, path.normalize(decodeURIComponent(url)));
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('No encontrado');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// Sin compresión por mensaje: con mensajes de 25 a 1000 bytes solo suma CPU y latencia.
const wss = new WebSocketServer({ server, maxPayload: 4096, perMessageDeflate: false });
const rooms = new Map();
let MODES = null;

const RATE_PER_SEC = 40; // mensajes por segundo por conexión (token bucket)
const RATE_BURST = 80;
const PING_EVERY_MS = 4000;
const DEAD_AFTER_MS = 30000;

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
}

wss.on('connection', (ws) => {
  // Nagle apagado: que TCP no junte mensajes chicos (puede retenerlos ~40 ms).
  ws._socket.setNoDelay(true);
  ws.lastPong = Date.now();
  ws.on('pong', () => (ws.lastPong = Date.now()));
  const bucket = { tokens: RATE_BURST, at: Date.now() };
  let room = null;
  let player = null;

  ws.on('message', (raw) => {
    const now = Date.now();
    bucket.tokens = Math.min(RATE_BURST, bucket.tokens + ((now - bucket.at) / 1000) * RATE_PER_SEC);
    bucket.at = now;
    if (--bucket.tokens < 0) return ws.close(1008, 'Demasiados mensajes');

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    try {
      if (room) return room.handle(player, msg);
      if (msg.t !== 'create' && msg.t !== 'join') return;

      const name = cleanName(msg.name);
      if (!name) return send(ws, { t: 'error', msg: 'Poné un nombre' });
      const key = typeof msg.key === 'string' ? msg.key.slice(0, 64) : '';

      let target;
      if (msg.t === 'create') {
        target = new Room(makeCode(), MODES);
        rooms.set(target.code, target);
      } else {
        target = rooms.get(String(msg.code || '').toUpperCase().trim());
        if (!target) return send(ws, { t: 'error', code: 'noroom', msg: 'No existe esa sala' });
      }
      const result = target.addPlayer(ws, name, key);
      if (result.error) return send(ws, { t: 'error', msg: result.error });
      room = target;
      player = result.player;
    } catch (e) {
      console.error('mensaje', msg.t, e);
    }
  });

  ws.on('close', () => {
    try {
      if (room && player) room.removeConnection(player, ws);
    } catch (e) {
      console.error('close', e);
    }
  });
});

// Un loop a 60 Hz para todas las salas; cada sala acumula tiempo y simula con paso fijo.
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  for (const [code, room] of rooms) {
    try {
      room.tick(dt, now);
      if (room.isAbandoned(now)) rooms.delete(code);
    } catch (e) {
      console.error('sala', code, e);
    }
  }
}, 1000 / 60);

// Keepalive con ping de protocolo: lo contesta la capa de red del navegador aunque la pestaña esté de fondo.
setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (now - ws.lastPong > DEAD_AFTER_MS) ws.terminate();
    else ws.ping();
  }
}, PING_EVERY_MS);

import('./public/game/modes.js').then((m) => {
  MODES = m.MODES;
  server.listen(PORT, () => console.log(`Time to Break en http://localhost:${PORT}`));
});
