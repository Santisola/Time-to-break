// Simulación de la partida. Corre en un Web Worker del navegador del host para que siga a 30 Hz
// aunque el host cambie de pestaña (los timers del hilo principal se frenan en segundo plano).
import { MODES } from './modes.js';
import { W, H } from './base.js';

const TICK_MS = 1000 / 30;
const COUNTDOWN = 3;

const players = new Map(); // id -> { id, name, connected, input, dashSeq }
let mode = null;
let modeKey = null;
let phase = 'idle'; // idle | countdown | playing
let countdown = 0;
let last = performance.now();

const post = (msg) => postMessage(msg);

function roundMsg() {
  return {
    t: 'round',
    mode: modeKey,
    title: mode.constructor.title,
    help: mode.constructor.help,
    world: { w: W, h: H },
    phys: mode.phys,
    info: mode.staticInfo(),
  };
}

function finish() {
  const r = mode.results();
  post({ t: 'results', mode: modeKey, title: r.title, lines: r.lines, points: r.points });
  mode = null;
  phase = 'idle';
}

onmessage = ({ data: m }) => {
  switch (m.t) {
    case 'players':
      for (const p of m.list) {
        const cur = players.get(p.id);
        if (cur) Object.assign(cur, { name: p.name, connected: p.connected });
        else players.set(p.id, { id: p.id, name: p.name, connected: p.connected, input: { x: 0, y: 0 }, dashSeq: 0 });
        if (!p.connected) players.get(p.id).input = { x: 0, y: 0 };
      }
      break;
    case 'input': {
      const p = players.get(m.id);
      if (!p) return;
      let x = Number(m.x) || 0;
      let y = Number(m.y) || 0;
      const len = Math.hypot(x, y);
      if (len > 1) {
        x /= len;
        y /= len;
      }
      p.input = { x, y };
      if (Number.isInteger(m.d)) p.dashSeq = m.d;
      break;
    }
    case 'start': {
      if (phase !== 'idle') return;
      const def = MODES[m.mode];
      if (!def) return;
      const list = [...players.values()].filter((p) => p.connected);
      if (list.length < def.minPlayers) {
        return post({ t: 'error', msg: `${def.Mode.title} necesita al menos ${def.minPlayers} jugadores` });
      }
      mode = new def.Mode(list);
      modeKey = m.mode;
      phase = 'countdown';
      countdown = COUNTDOWN;
      post({ t: 'phase', phase, mode: modeKey });
      post({ t: 'round', round: roundMsg() });
      break;
    }
    case 'end':
      if (phase === 'playing') finish();
      break;
    case 'abort':
      mode = null;
      phase = 'idle';
      break;
    case 'sync':
      if (mode) post({ t: 'round', round: roundMsg(), to: m.id });
      break;
  }
};

setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!mode) return;

  if (phase === 'countdown') {
    countdown -= dt;
    if (countdown <= 0) {
      phase = 'playing';
      post({ t: 'phase', phase, mode: modeKey });
    }
  }
  mode.tick(dt, phase === 'countdown');
  const s = mode.snapshot();
  post({ t: 'snap', s: { t: 's', ph: phase, cd: Math.ceil(countdown), tl: s.tl, b: s.b, x: s.x }, v: s.v });
  const rel = mode.reliable();
  if (rel) post({ t: 'x', x: { t: 'x', ...rel } });
  if (phase === 'playing' && mode.isDone()) finish();
}, TICK_MS);
