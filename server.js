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

const wss = new WebSocketServer({ server, maxPayload: 4096 });
const rooms = new Map();

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
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  let room = null;
  let player = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (room) return room.handle(player, msg);
    if (msg.t !== 'create' && msg.t !== 'join') return;

    const name = cleanName(msg.name);
    if (!name) return send(ws, { t: 'error', msg: 'Poné un nombre' });
    const key = typeof msg.key === 'string' ? msg.key.slice(0, 64) : '';

    let target;
    if (msg.t === 'create') {
      target = new Room(makeCode());
      rooms.set(target.code, target);
    } else {
      target = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!target) return send(ws, { t: 'error', code: 'noroom', msg: 'No existe esa sala' });
    }
    const result = target.addPlayer(ws, name, key);
    if (result.error) return send(ws, { t: 'error', msg: result.error });
    room = target;
    player = result.player;
  });

  ws.on('close', () => {
    if (room && player) room.removeConnection(player, ws);
  });
});

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const [code, room] of rooms) {
    room.tick(dt);
    if (room.isAbandoned(now)) rooms.delete(code);
  }
}, 1000 / 30);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

server.listen(PORT, () => console.log(`Time to Break en http://localhost:${PORT}`));
