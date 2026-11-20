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

// Armado del partido de fútbol (pantalla previa): tamaño de cancha = jugadores por equipo.
const FB_SIZES = { '1v1': 1, '3v3': 3, '5v5': 5, '7v7': 7 };
const FB_MINUTES = [2, 3, 5, 0]; // 0 = sin límite
const FB_GOALS = [3, 5, 7, 0]; // 0 = sin límite

// Modo party: los juegos se sortean sin repetir hasta que salieron todos; entre juego y juego,
// PARTY_PAUSE_MS para ver el resultado y arranca el siguiente solo.
const PARTY_PAUSE_MS = 10000;
const PARTY_FUTBOL = { minutes: 2, goals: 3 };

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
    this.setup = null; // 'futbol' mientras está abierta la pantalla de armado
    this.fb = { size: '5v5', minutes: 3, goals: 5, teams: {} }; // teams: id → 0 (Rojo) | 1 (Azul)
    this.party = null; // { round, bag, last, nextKey, nextAt }
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
        // Acciones: se aplican al llegar, sin esperar al paso.
        if (this.phase === 'playing') this.mode.dash(p.id);
        return;
      case 'kick':
        if (this.phase === 'playing') this.mode.kick?.(p.id);
        return;
      case 'eco':
        // Medición de latencia: se devuelve tal cual. El cliente informa su último RTT para el lobby.
        if (Number.isFinite(msg.r)) p.rtt = Math.round(Math.min(9999, Math.max(0, msg.r)));
        return send(p.ws, { t: 'eco', c: msg.c });
    }

    if (msg.t === 'fb') return this.handleFutbol(p, msg);

    if (p.id !== this.hostId) return;
    if (msg.t === 'setup' && !this.inRound()) {
      this.setup = msg.mode === 'futbol' ? 'futbol' : null;
      if (this.setup && !Object.keys(this.fb.teams).length) this.randomTeams();
      return this.broadcastRoom();
    }
    if (msg.t === 'start' && !this.party) return this.start(p, msg.mode);
    if (msg.t === 'end' && this.phase === 'playing') return this.finish();
    if (msg.t === 'party') return this.handleParty(p, msg.op);
    // Podio: "Finalizar Time to Break" (o fin del party). Muestra a todos el top 3 y la tabla.
    if (msg.t === 'podium' && !this.inRound()) return this.showPodium();
    if (msg.t === 'scores' && msg.op === 'reset' && !this.inRound()) {
      for (const pl of this.players.values()) pl.score = 0;
      return this.broadcastRoom();
    }
    if (msg.t === 'lobby' && (this.phase === 'results' || this.phase === 'podium') && !this.party) {
      this.phase = 'lobby';
      this.mode = null;
      this.results = null;
      this.broadcastRoom();
    }
  }

  handleParty(host, op) {
    if (op === 'start' && !this.party && !this.inRound()) {
      for (const pl of this.players.values()) pl.score = 0; // el podio refleja solo el party
      this.setup = null;
      this.party = { round: 0, bag: [], last: null, nextKey: null, nextAt: 0 };
      this.party.nextKey = this.partyDraw();
      return this.partyLaunch(host);
    }
    if (!this.party) return;
    if (op === 'next' && this.phase === 'results') return this.partyLaunch(host);
    if (op === 'stop' && !this.inRound()) return this.showPodium();
  }

  // Saca el próximo juego de la bolsa; cuando se vacía, se vuelve a mezclar (sin repetir el último).
  partyDraw() {
    const party = this.party;
    const keys = Object.keys(this.MODES);
    for (let tries = 0; tries < keys.length * 2; tries++) {
      if (!party.bag.length) {
        party.bag = keys.sort(() => Math.random() - 0.5);
        if (party.bag.length > 1 && party.bag[party.bag.length - 1] === party.last) party.bag.unshift(party.bag.pop());
      }
      const key = party.bag.pop();
      if (this.connected().length >= this.MODES[key].minPlayers) return key;
    }
    return null;
  }

  partyLaunch(host) {
    const key = this.party.nextKey;
    if (!key) {
      send(host?.ws, { t: 'error', msg: 'No hay suficientes jugadores para ningún juego' });
      this.party = null;
      return this.broadcastRoom();
    }
    this.party.round++;
    this.party.last = key;
    this.party.nextKey = null;
    // Haxblobs en party: equipos al azar y la cancha más chica donde entren todos.
    const options = key === 'futbol' ? this.partyFutbol() : undefined;
    this.start(host, key, options);
    if (!this.inRound()) {
      // No arrancó (se fue gente y no alcanza el mínimo): sortear otro y reintentar en unos segundos.
      this.party.round--;
      this.party.nextKey = this.partyDraw();
      this.party.nextAt = Date.now() + 3000;
      this.broadcastRoom();
    }
  }

  partyFutbol() {
    const players = this.connected().sort(() => Math.random() - 0.5);
    const size = ['1v1', '3v3', '5v5', '7v7'].find((k) => FB_SIZES[k] * 2 >= players.length) || '7v7';
    const teams = {};
    players.slice(0, FB_SIZES[size] * 2).forEach((pl, i) => (teams[pl.id] = i % 2));
    return { size, teams, ...PARTY_FUTBOL };
  }

  showPodium() {
    this.party = null;
    this.setup = null;
    this.mode = null;
    this.phase = 'podium';
    this.broadcastRoom();
  }

  // Pantalla de armado del fútbol: cada uno elige su equipo; el host mueve a cualquiera y configura.
  handleFutbol(p, msg) {
    if (this.inRound()) return;
    const host = p.id === this.hostId;
    const fb = this.fb;
    switch (msg.op) {
      case 'team': {
        const id = Number(msg.id);
        if (!this.players.has(id) || (!host && id !== p.id)) return;
        const team = msg.team === 0 || msg.team === 1 ? msg.team : null;
        if (team === null) delete fb.teams[id];
        else if (fb.teams[id] !== team) {
          if (this.teamCount(team) >= FB_SIZES[fb.size]) return send(p.ws, { t: 'error', msg: 'Ese equipo está completo' });
          fb.teams[id] = team;
        }
        break;
      }
      case 'cfg':
        if (!host) return;
        if (msg.size in FB_SIZES) {
          fb.size = msg.size;
          this.trimTeams();
        }
        if (FB_MINUTES.includes(msg.minutes)) fb.minutes = msg.minutes;
        if (FB_GOALS.includes(msg.goals)) fb.goals = msg.goals;
        if (!fb.minutes && !fb.goals) fb.goals = 5; // algún final tiene que tener
        break;
      case 'random':
        if (!host) return;
        this.randomTeams();
        break;
      case 'reset':
        if (!host) return;
        fb.teams = {};
        break;
      default:
        return;
    }
    this.broadcastRoom();
  }

  teamCount(team) {
    return Object.entries(this.fb.teams).filter(([id, t]) => t === team && this.players.get(Number(id))?.connected).length;
  }

  // Si se achica la cancha, los que no entran pasan a espectadores (quedan los primeros en sumarse).
  trimTeams() {
    const max = FB_SIZES[this.fb.size];
    for (const team of [0, 1]) {
      const ids = Object.keys(this.fb.teams).filter((id) => this.fb.teams[id] === team);
      for (const id of ids.slice(max)) delete this.fb.teams[id];
    }
  }

  randomTeams() {
    const max = FB_SIZES[this.fb.size];
    const list = this.connected().sort(() => Math.random() - 0.5).slice(0, max * 2);
    this.fb.teams = {};
    list.forEach((pl, i) => (this.fb.teams[pl.id] = i % 2));
  }

  start(host, key, preset) {
    if (this.inRound()) return;
    const def = this.MODES[key];
    if (!def) return;
    let players = this.connected();
    let options = preset;
    if (key === 'futbol') {
      // Juegan los que están en un equipo; el resto mira.
      options ??= { ...this.fb, perTeam: FB_SIZES[this.fb.size] };
      players = players.filter((pl) => options.teams[pl.id] === 0 || options.teams[pl.id] === 1);
    }
    if (players.length < def.minPlayers) {
      const msg = key === 'futbol' ? 'Armá los equipos: no hay nadie en Rojo ni en Azul' : `${def.Mode.title} necesita al menos ${def.minPlayers} jugadores`;
      return send(host?.ws, { t: 'error', msg });
    }
    this.modeKey = key;
    this.mode = new def.Mode(players, options);
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
    if (this.party && (this.phase === 'results' || this.phase === 'lobby') && now >= this.party.nextAt) {
      return this.partyLaunch(this.players.get(this.hostId));
    }
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
    if (this.party) {
      this.party.nextKey = this.partyDraw();
      this.party.nextAt = Date.now() + PARTY_PAUSE_MS;
    }
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
      setup: this.setup,
      fb: this.fb,
      party: this.party && {
        round: this.party.round,
        next: this.party.nextKey,
        nextIn: this.inRound() ? null : Math.max(0, this.party.nextAt - Date.now()),
      },
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
