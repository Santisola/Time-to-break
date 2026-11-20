// Sala: jugadores, host, fases, puntajes y la partida, que simula el servidor (autoritativo).
// Los modos son los mismos módulos que usa el cliente para predecir (public/game/).

const STEP = 1 / 60; // física con paso fijo
const MAX_STEPS = 5; // si el proceso se trabó, no intentar "ponerse al día"
const SNAPSHOT_EVERY = 1; // snapshots a 60 Hz: ~16 ms menos de espera; con 20 jugadores son ~50 KB/s por cliente
const MAX_PLAYERS = 24;
const COUNTDOWN = 3;
const ABANDON_MS = 10 * 60 * 1000;
const HOST_GRACE_MS = 8000;
const LOBBY_REFRESH_MS = 3000;

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

class Room {
  constructor(code, MODES) {
    this.code = code;
    this.MODES = MODES;
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
    this.acc = 0;
    this.steps = 0;
    this.lastLobbyRefresh = 0;
  }

  connected() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  inRound() {
    return this.phase === 'countdown' || this.phase === 'playing';
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
      p = { id, key, name, ws, connected: true, score: 0, color: `hsl(${hue},85%,62%)`, input: { x: 0, y: 0 }, rtt: null };
      this.players.set(id, p);
    }
    const host = this.players.get(this.hostId);
    if (!host || (!host.connected && Date.now() - host.leftAt > HOST_GRACE_MS)) this.hostId = p.id;
    this.emptySince = null;

    send(ws, { t: 'joined', code: this.code, id: p.id });
    if (this.mode && this.inRound()) send(ws, this.roundMsg());
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
    switch (msg.t) {
      case 'in': {
        // Intención de movimiento: llega solo cuando cambia; la consume el próximo paso.
        let x = Number(msg.x) || 0;
        let y = Number(msg.y) || 0;
        const len = Math.hypot(x, y);
        if (len > 1) {
          x /= len;
          y /= len;
        }
        p.input = { x, y };
        return;
      }
      case 'dash':
        // Acción: se aplica al llegar, sin esperar al paso.
        if (this.phase === 'playing') this.mode.dash(p.id);
        return;
      case 'eco':
        // Medición de latencia: se devuelve tal cual. El cliente informa su último RTT para el lobby.
        if (Number.isFinite(msg.r)) p.rtt = Math.round(Math.min(9999, Math.max(0, msg.r)));
        return send(p.ws, { t: 'eco', c: msg.c });
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
    if (this.inRound()) return;
    const def = this.MODES[key];
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
    this.acc = 0;
    this.broadcast(this.roundMsg());
    this.broadcastRoom();
  }

  roundMsg() {
    return {
      t: 'round',
      mode: this.modeKey,
      title: this.mode.constructor.title,
      help: this.mode.constructor.help,
      phys: this.mode.phys,
      info: this.mode.staticInfo(),
    };
  }

  // Lo llama el loop global a 60 Hz con el tiempo real transcurrido.
  tick(dt, now) {
    this.checkHost(now);
    if (!this.inRound()) {
      // Refresco periódico del lobby para mostrar el ping de cada uno.
      if (now - this.lastLobbyRefresh > LOBBY_REFRESH_MS && this.connected().length) {
        this.lastLobbyRefresh = now;
        this.broadcastRoom();
      }
      return;
    }

    this.acc += dt;
    let n = 0;
    while (this.acc >= STEP && n < MAX_STEPS && this.inRound()) {
      this.step();
      this.acc -= STEP;
      n++;
    }
    if (n === MAX_STEPS) this.acc = 0;
  }

  step() {
    if (this.phase === 'countdown') {
      this.countdown -= STEP;
      if (this.countdown <= 0) {
        this.phase = 'playing';
        this.broadcastRoom();
      }
    }
    this.mode.tick(STEP, this.phase === 'countdown');
    if (++this.steps % SNAPSHOT_EVERY === 0) this.sendSnapshot();
    if (this.phase === 'playing' && this.mode.isDone()) this.finish();
  }

  sendSnapshot() {
    const s = this.mode.snapshot();
    const rel = this.mode.reliable();
    const msg = { t: 's', ph: this.phase, cd: Math.ceil(this.countdown), tl: s.tl, b: s.b, x: s.x };
    if (rel) Object.assign(msg, rel);
    // Mismo snapshot para todos + lo que cada uno necesita para predecir su propio blob.
    const common = JSON.stringify(msg).slice(0, -1);
    for (const p of this.players.values()) {
      if (p.ws) send(p.ws, `${common},"v":${JSON.stringify(s.v[p.id] ?? null)}}`);
    }
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
    this.mode = null;
    this.broadcast(this.results);
    this.broadcastRoom();
  }

  // Si el host recarga la página tiene unos segundos para volver antes de perder la corona.
  checkHost(now) {
    const host = this.players.get(this.hostId);
    if (host && !host.connected && now - host.leftAt > HOST_GRACE_MS) {
      const next = this.connected()[0];
      if (next) {
        this.hostId = next.id;
        this.broadcastRoom();
      }
    }
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
        rtt: p.rtt,
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
