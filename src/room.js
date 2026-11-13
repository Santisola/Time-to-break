const MODES = require('./modes');
const { W, H } = require('./modes/base');

const MAX_PLAYERS = 24;
const COUNTDOWN = 3;
const ABANDON_MS = 10 * 60 * 1000;
const HOST_GRACE_MS = 8000;

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.hostId = null;
    this.phase = 'lobby'; // lobby | countdown | playing | results
    this.modeKey = null;
    this.mode = null;
    this.countdown = 0;
    this.results = null;
    this.nextId = 1;
    this.hueSeed = Math.random() * 360;
    this.emptySince = Date.now();
  }

  connected() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  addPlayer(ws, name, key) {
    let p = key ? [...this.players.values()].find((x) => x.key === key) : null;
    if (p) {
      if (p.ws && p.ws !== ws) {
        send(p.ws, { t: 'kicked' });
        p.ws.close();
      }
      Object.assign(p, { ws, name, connected: true });
    } else {
      if (this.connected().length >= MAX_PLAYERS) return { error: 'La sala está llena' };
      const id = this.nextId++;
      const hue = Math.round((this.hueSeed + id * 137.508) % 360);
      p = { id, key, name, ws, connected: true, score: 0, color: `hsl(${hue},85%,62%)`, input: { x: 0, y: 0 }, dashSeq: 0 };
      this.players.set(id, p);
    }
    const host = this.players.get(this.hostId);
    if (!host || (!host.connected && Date.now() - host.leftAt > HOST_GRACE_MS)) this.hostId = p.id;
    this.emptySince = null;

    send(ws, { t: 'joined', code: this.code, id: p.id });
    if (this.mode && this.phase !== 'lobby') send(ws, this.roundMsg());
    if (this.phase === 'results' && this.results) send(ws, this.results);
    this.broadcastRoom();
    return { player: p };
  }

  removeConnection(p, ws) {
    if (p.ws !== ws) return;
    p.ws = null;
    p.connected = false;
    p.input = { x: 0, y: 0 };
    p.leftAt = Date.now();
    if (!this.connected().length) this.emptySince = Date.now();
    this.broadcastRoom();
  }

  handle(p, msg) {
    if (msg.t === 'input') {
      let x = Number(msg.x) || 0;
      let y = Number(msg.y) || 0;
      const len = Math.hypot(x, y);
      if (len > 1) {
        x /= len;
        y /= len;
      }
      p.input = { x, y };
      if (Number.isInteger(msg.d)) p.dashSeq = msg.d;
      return;
    }
    if (p.id !== this.hostId) return;
    if (msg.t === 'start') return this.start(p, msg.mode);
    if (msg.t === 'end' && this.phase === 'playing') return this.finish();
    if (msg.t === 'lobby' && this.phase === 'results') {
      this.phase = 'lobby';
      this.mode = null;
      this.results = null;
      this.broadcastRoom();
    }
  }

  start(host, key) {
    if (this.phase === 'countdown' || this.phase === 'playing') return;
    const def = MODES[key];
    if (!def) return;
    const players = this.connected();
    if (players.length < def.minPlayers) {
      return send(host.ws, { t: 'error', msg: `${def.Mode.title} necesita al menos ${def.minPlayers} jugadores` });
    }
    this.modeKey = key;
    this.mode = new def.Mode(players);
    this.phase = 'countdown';
    this.countdown = COUNTDOWN;
    this.results = null;
    this.broadcast(this.roundMsg());
    this.broadcastRoom();
  }

  roundMsg() {
    return {
      t: 'round',
      mode: this.modeKey,
      title: this.mode.constructor.title,
      help: this.mode.constructor.help,
      world: { w: W, h: H },
      info: this.mode.staticInfo(),
    };
  }

  tick(dt) {
    // Si el host recarga la página tiene unos segundos para volver antes de perder la corona.
    const host = this.players.get(this.hostId);
    if (host && !host.connected && Date.now() - host.leftAt > HOST_GRACE_MS) {
      const next = this.connected()[0];
      if (next) {
        this.hostId = next.id;
        this.broadcastRoom();
      }
    }
    if (this.phase !== 'countdown' && this.phase !== 'playing') return;
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'playing';
        this.broadcastRoom();
      }
    }
    this.mode.tick(dt, this.phase === 'countdown');
    this.broadcast(JSON.stringify({ t: 's', ph: this.phase, cd: Math.ceil(this.countdown), ...this.mode.snapshot() }));
    if (this.phase === 'playing' && this.mode.isDone()) this.finish();
  }

  finish() {
    const r = this.mode.results();
    const round = this.mode.bodies.map((b) => {
      const pts = r.points[b.id] || 0;
      b.p.score += pts;
      return { id: b.id, name: b.p.name, color: b.p.color, pts };
    });
    round.sort((a, b) => b.pts - a.pts);
    this.results = { t: 'results', mode: this.modeKey, title: r.title, lines: r.lines, round };
    this.phase = 'results';
    this.broadcast(this.results);
    this.broadcastRoom();
  }

  broadcastRoom() {
    this.broadcast({
      t: 'room',
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      mode: this.modeKey,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        score: p.score,
        connected: p.connected,
      })),
    });
  }

  broadcast(msg) {
    const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const p of this.players.values()) send(p.ws, data);
  }

  isAbandoned(now) {
    return this.emptySince !== null && now - this.emptySince > ABANDON_MS;
  }
}

module.exports = { Room, send };
