import { BaseMode, W, H, cluster } from './base.js';

// Física calibrada con los valores que usan los estadios de HaxBall (playerPhysics / ballPhysics por
// defecto que traen los .hbs exportados), pasados a nuestra escala: allá el jugador mide 15 y la pelota
// 10 (acá 22 y 15 → ×1,47); allá todo es "por tick" a 60 Hz, acá por segundo.
//   jugador: damping 0,96/tick → frenado 2,45/s · acceleration 0,1 → velocidad terminal ~2,4/tick ≈ 210 px/s
//   pelota:  damping 0,99/tick → 0,6/s · invMass 1 vs 0,5 del jugador → pesa la mitad
//   rebotes: se multiplican los bCoef (0,5 × 0,5 = 0,25 jugador–pelota; pared 1 × 0,5; red 0,1 × 0,5)
//   patada:  kickStrength 5/tick ≈ 440 px/s; dirección = del centro del jugador hacia la pelota
// Ajustes propios sobre esa base: pelota tipo futsal (más chica, desliza más) y blob más chico que en
// los otros juegos, para que la cancha se sienta más grande.

// Canchas según jugadores por equipo: ancho, alto, medio arco y profundidad del arco.
const SIZES = {
  '1v1': { w: 880, h: 470, goal: 82, depth: 48 },
  '3v3': { w: 1250, h: 660, goal: 105, depth: 55 },
  '5v5': { w: 1550, h: 840, goal: 120, depth: 60 },
  '7v7': { w: 1850, h: 980, goal: 135, depth: 65 },
};
const BALL_R = 9; // futsal: chica
const PLAYER_R = 17; // en los otros juegos 22
const POST_R = 10;

function stadium(size) {
  const s = SIZES[size] || SIZES['5v5'];
  const cx = W / 2;
  const cy = H / 2;
  const field = { x0: cx - s.w / 2, y0: cy - s.h / 2, x1: cx + s.w / 2, y1: cy + s.h / 2, cx, cy };
  const goal = { top: cy - s.goal, bottom: cy + s.goal, depth: s.depth };
  const posts = [
    { x: field.x0, y: goal.top, r: POST_R },
    { x: field.x0, y: goal.bottom, r: POST_R },
    { x: field.x1, y: goal.top, r: POST_R },
    { x: field.x1, y: goal.bottom, r: POST_R },
  ];
  // Los jugadores pueden pisar un poco afuera de las líneas; la cámara encuadra ese rectángulo.
  const box = { x0: field.x0 - s.depth - 30, y0: field.y0 - 45, x1: field.x1 + s.depth + 30, y1: field.y1 + 45 };
  const circleR = Math.min(100, s.h * 0.18); // círculo central (zona prohibida en el saque para el que no saca)
  return { field, goal, posts, box, circleR };
}
const TEAMS = [
  { name: 'Rojo', color: '#ff4d6d' },
  { name: 'Azul', color: '#3a86ff' },
];

const BALL_MASS = 0.5; // el jugador pesa 1
const BALL_FRICTION = 0.35; // por segundo: futsal, desliza rápido y lejos
const BOUNCE_PLAYER = 0.25; // jugador–pelota: la pelota se "pega" y se puede conducir
const BOUNCE_WALL = 0.5;
const BOUNCE_POST = 0.25;
const BOUNCE_NET = 0.05; // la red frena la pelota
const BALL_MAX_SPEED = 950;

// Patada (botón aparte): la pelota tiene que estar dentro del área de disparo, un anillo de KICK_REACH
// alrededor del blob. Cuanto más pegada, más fuerte. Si se aprieta un instante antes de que entre,
// cuenta igual (KICK_ARMED): compensa la latencia y el timing humano.
const KICK_REACH = 16; // px desde el borde del blob
const KICK_MIN = 360; // pelota en el borde del área
const KICK_MAX = 560; // pelota pegada
// Pelotazo: si la pelota que pateó otro te pega de lleno a esta velocidad o más, quedás mareado (solo visual).
const DAZE_SPEED = 400;
const DAZE_TIME = 1.5;
const KICK_ARMED = 0.15;
const KICKBACK = 40; // empujoncito para atrás al que patea
const DASH_PUSH = 220; // embestir la pelota la empuja fuerte, pero menos que una patada

const CELEBRATION = 2.2;

class Futbol extends BaseMode {
  static title = 'Haxblobs';
  static help = 'Espacio (o X) patea: cuanto más pegada la pelota, más fuerte. Shift embiste.';

  // options (pantalla de armado): { size, minutes, goals, teams: { id: 0|1 } }. 0 = sin límite.
  constructor(players, options = {}) {
    super(players);
    const st = stadium(options.size);
    this.field = st.field;
    this.arco = st.goal;
    this.postList = st.posts;
    this.box = st.box;
    this.circleR = st.circleR;
    this.duration = options.minutes === 0 ? Infinity : (options.minutes || 3) * 60;
    this.winGoals = options.goals === 0 ? Infinity : options.goals || 5;
    if (this.duration === Infinity && this.winGoals === Infinity) this.winGoals = 5;
    this.overtime = false;
    this.phys = { grip: 2.45, maxV: 215, dashPow: 480, bounce: 0.25, dashBoost: 120, bounded: true, box: this.box };
    this.score = [0, 0];
    this.goals = {};
    this.dazes = {}; // pelotazos recibidos por jugador
    this.ball = { x: this.field.cx, y: this.field.cy, vx: 0, vy: 0 };
    this.lastTouch = null;
    this.pause = 0;
    this.lastGoal = null;
    const teams = options.teams || {};
    this.bodies.forEach((b, i) => {
      b.tm = teams[b.id] === 0 || teams[b.id] === 1 ? teams[b.id] : i % 2;
      b.r = PLAYER_R;
      b.kickArmed = 0;
      b.kickFlash = 0;
      b.daze = 0;
    });
    this.kickoffTeam = Math.random() < 0.5 ? 0 : 1; // después de cada gol saca el que lo recibió
    this.kickoff();
  }

  // Saque del medio: cada equipo en su mitad, pelota quieta en el centro. Hasta que alguien la toque,
  // nadie cruza la mitad de cancha y el que no saca no entra al círculo central (ver kickoffLimits).
  kickoff() {
    const { cx, cy, x0, x1 } = this.field;
    for (let t = 0; t < 2; t++) {
      const members = this.bodies.filter((b) => b.tm === t);
      const x = t === 0 ? cx - (cx - x0) * 0.45 : cx + (x1 - cx) * 0.45;
      cluster(x, cy, members.length, 56).forEach((pos, i) => Object.assign(members[i], pos, { vx: 0, vy: 0 }));
    }
    Object.assign(this.ball, { x: cx, y: cy, vx: 0, vy: 0 });
    this.lastTouch = null;
    this.waitingKick = true;
  }

  kickoffLimits() {
    const { cx, cy } = this.field;
    for (const b of this.bodies) {
      if (!b.alive) continue;
      if (b.tm === 0 && b.x > cx - b.r) [b.x, b.vx] = [cx - b.r, Math.min(0, b.vx)];
      if (b.tm === 1 && b.x < cx + b.r) [b.x, b.vx] = [cx + b.r, Math.max(0, b.vx)];
      if (b.tm === this.kickoffTeam) continue;
      const dx = b.x - cx;
      const dy = b.y - cy;
      const d = Math.hypot(dx, dy);
      const min = this.circleR + b.r;
      if (d >= min) continue;
      // Afuera del círculo, por su lado de la cancha.
      const nx = d ? dx / d : b.tm === 0 ? -1 : 1;
      const ny = d ? dy / d : 0;
      b.x = cx + nx * min;
      b.y = cy + ny * min;
      const vn = b.vx * nx + b.vy * ny;
      if (vn < 0) {
        b.vx -= vn * nx;
        b.vy -= vn * ny;
      }
    }
  }

  // Botón de patear: se aplica al llegar el mensaje (como la embestida).
  kick(id) {
    const b = this.byId(id);
    if (!b || !b.alive || this.frozen || this.pause > 0 || b.stun > 0) return;
    b.kickArmed = KICK_ARMED;
    this.tryKick(b);
  }

  tryKick(b) {
    const ball = this.ball;
    const dx = ball.x - b.x;
    const dy = ball.y - b.y;
    const d = Math.hypot(dx, dy) || 1;
    const gap = d - b.r - BALL_R; // distancia entre bordes
    if (gap > KICK_REACH) return false;
    const close = 1 - Math.max(0, gap) / KICK_REACH; // 1 = pegada, 0 = en el borde
    const nx = dx / d;
    const ny = dy / d;
    // Se descarta lo que la pelota traía hacia el jugador y sale en la dirección de la patada.
    const vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0) {
      ball.vx -= vn * nx;
      ball.vy -= vn * ny;
    }
    const power = KICK_MIN + (KICK_MAX - KICK_MIN) * close;
    ball.vx += nx * power;
    ball.vy += ny * power;
    b.vx -= nx * KICKBACK;
    b.vy -= ny * KICKBACK;
    b.kickArmed = 0;
    b.kickFlash = 0.15;
    this.lastTouch = b;
    this.waitingKick = false;
    return true;
  }

  tick(dt, frozen) {
    if (!frozen) {
      if (this.pause > 0) {
        this.pause -= dt;
        if (this.pause <= 0) this.kickoff();
      } else if (!this.waitingKick) {
        this.time += dt; // el reloj corre desde que se mueve la pelota; se frena en el festejo
        // Se terminó el tiempo empatados: gol de oro.
        if (this.time >= this.duration && this.score[0] === this.score[1]) this.overtime = true;
      }
    }
    for (const b of this.bodies) {
      b.kickArmed = Math.max(0, b.kickArmed - dt);
      b.kickFlash = Math.max(0, b.kickFlash - dt);
      b.daze = Math.max(0, b.daze - dt);
    }
    const hold = frozen || this.pause > 0;
    this.move(dt, frozen);
    this.collide(null);
    this.posts(this.postList);
    this.bounds();
    if (this.waitingKick) this.kickoffLimits();
    if (!hold) {
      this.stepBall(dt);
      this.bounds(); // el choque con la pelota también mueve un poco al jugador
      if (this.waitingKick) this.kickoffLimits();
    }
  }

  stepBall(dt) {
    const ball = this.ball;
    const fade = Math.exp(-BALL_FRICTION * dt);
    ball.vx *= fade;
    ball.vy *= fade;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Patadas "armadas": se apretó un instante antes de que la pelota entrara en el área.
    for (const b of this.bodies) if (b.alive && b.kickArmed > 0) this.tryKick(b);

    // Choque jugador–pelota con masas distintas y poco rebote: se la puede llevar pegada.
    for (const b of this.bodies) {
      if (!b.alive) continue;
      const dx = ball.x - b.x;
      const dy = ball.y - b.y;
      const d = Math.hypot(dx, dy);
      const min = b.r + BALL_R;
      if (!d || d >= min) continue;
      const nx = dx / d;
      const ny = dy / d;
      const overlap = min - d;
      const share = BALL_MASS / (1 + BALL_MASS);
      ball.x += nx * overlap * (1 - share);
      ball.y += ny * overlap * (1 - share);
      b.x -= nx * overlap * share;
      b.y -= ny * overlap * share;
      const rv = (ball.vx - b.vx) * nx + (ball.vy - b.vy) * ny;
      const kicker = this.lastTouch;
      if (-rv >= DAZE_SPEED && kicker && kicker !== b && b.daze <= 0) {
        b.daze = DAZE_TIME;
        this.dazes[b.id] = (this.dazes[b.id] || 0) + 1;
        this.event(`😵 ${b.p.name} se comió un pelotazo de ${kicker.p.name}`);
      }
      if (rv < 0) {
        const j = (-(1 + BOUNCE_PLAYER) * rv) / (1 + 1 / BALL_MASS);
        ball.vx += (j / BALL_MASS) * nx;
        ball.vy += (j / BALL_MASS) * ny;
        b.vx -= j * nx;
        b.vy -= j * ny;
      }
      if (b.dashT > 0) {
        ball.vx += nx * DASH_PUSH;
        ball.vy += ny * DASH_PUSH;
        b.dashT = 0;
      }
      this.lastTouch = b;
      this.waitingKick = false;
    }

    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > BALL_MAX_SPEED) {
      ball.vx *= BALL_MAX_SPEED / speed;
      ball.vy *= BALL_MAX_SPEED / speed;
    }

    for (const p of this.postList) {
      const dx = ball.x - p.x;
      const dy = ball.y - p.y;
      const d = Math.hypot(dx, dy);
      const min = BALL_R + p.r;
      if (!d || d >= min) continue;
      const nx = dx / d;
      const ny = dy / d;
      ball.x = p.x + nx * min;
      ball.y = p.y + ny * min;
      const vn = ball.vx * nx + ball.vy * ny;
      if (vn < 0) {
        ball.vx -= (1 + BOUNCE_POST) * vn * nx;
        ball.vy -= (1 + BOUNCE_POST) * vn * ny;
      }
    }

    this.ballWalls();

    // Gol: la pelota cruzó entera la línea, dentro del arco.
    if (ball.x < this.field.x0 - BALL_R) this.goal(1);
    else if (ball.x > this.field.x1 + BALL_R) this.goal(0);
  }

  ballWalls() {
    const ball = this.ball;
    const inMouth = ball.y > this.arco.top && ball.y < this.arco.bottom;
    const bounce = (axis, limit, dir, coef) => {
      ball[axis] = limit;
      const v = axis === 'x' ? 'vx' : 'vy';
      if (ball[v] * dir < 0) ball[v] = -ball[v] * coef;
    };
    // Laterales de la cancha.
    if (ball.y - BALL_R < this.field.y0) bounce('y', this.field.y0 + BALL_R, 1, BOUNCE_WALL);
    if (ball.y + BALL_R > this.field.y1) bounce('y', this.field.y1 - BALL_R, -1, BOUNCE_WALL);
    // Líneas de fondo: rebota salvo en la boca del arco.
    if (!inMouth) {
      if (ball.x - BALL_R < this.field.x0 && ball.x > this.field.x0 - BALL_R) bounce('x', this.field.x0 + BALL_R, 1, BOUNCE_WALL);
      if (ball.x + BALL_R > this.field.x1 && ball.x < this.field.x1 + BALL_R) bounce('x', this.field.x1 - BALL_R, -1, BOUNCE_WALL);
    }
    // Dentro del arco: la red frena.
    if (ball.x < this.field.x0 || ball.x > this.field.x1) {
      if (ball.y - BALL_R < this.arco.top) bounce('y', this.arco.top + BALL_R, 1, BOUNCE_NET);
      if (ball.y + BALL_R > this.arco.bottom) bounce('y', this.arco.bottom - BALL_R, -1, BOUNCE_NET);
      if (ball.x - BALL_R < this.field.x0 - this.arco.depth) bounce('x', this.field.x0 - this.arco.depth + BALL_R, 1, BOUNCE_NET);
      if (ball.x + BALL_R > this.field.x1 + this.arco.depth) bounce('x', this.field.x1 + this.arco.depth - BALL_R, -1, BOUNCE_NET);
    }
  }

  goal(team) {
    this.score[team]++;
    const who = this.lastTouch;
    const teamName = TEAMS[team].name;
    if (who && who.tm === team) {
      this.goals[who.id] = (this.goals[who.id] || 0) + 1;
      this.lastGoal = `Gol de ${who.p.name}`;
      this.event(`⚽ ¡Gol de ${who.p.name}! (${teamName})`);
    } else if (who) {
      this.lastGoal = `En contra de ${who.p.name}`;
      this.event(`🙈 ${who.p.name} la metió en contra (punto para ${teamName})`);
    } else {
      this.lastGoal = `Gol de ${teamName}`;
      this.event(`⚽ ¡Gol de ${teamName}!`);
    }
    this.pause = CELEBRATION;
    this.kickoffTeam = 1 - team;
    Object.assign(this.ball, { vx: 0, vy: 0 });
  }

  isDone() {
    if (this.pause > 0) return false; // dejar ver el festejo del último gol
    if (Math.max(...this.score) >= this.winGoals) return true;
    return this.time >= this.duration && this.score[0] !== this.score[1]; // empatados: gol de oro
  }

  results() {
    const [a, b] = this.score;
    const winner = a === b ? null : a > b ? 0 : 1;
    const points = {};
    for (const body of this.bodies) {
      let pts = (this.goals[body.id] || 0) * 2;
      if (winner === null) pts += 2;
      else if (body.tm === winner) pts += 4;
      points[body.id] = pts;
    }
    const title = winner === null ? `Empate ${a} a ${b}` : `¡Ganó ${TEAMS[winner].name} ${Math.max(a, b)} a ${Math.min(a, b)}!`;
    const lines = [];
    const top = Object.entries(this.goals).sort((x, y) => y[1] - x[1])[0];
    if (top) lines.push(`Goleador: ${this.byId(Number(top[0])).p.name} (${top[1]})`);
    const hit = Object.entries(this.dazes).sort((x, y) => y[1] - x[1])[0];
    if (hit) lines.push(`😵 Imán de pelotazos: ${this.byId(Number(hit[0])).p.name} (${hit[1]})`);
    return { title, lines, points };
  }

  bodyState(body) {
    const o = { ...super.bodyState(body), tm: body.tm };
    if (body.kickFlash > 0 || body.kickArmed > 0) o.k = 1;
    if (body.daze > 0) o.dz = 1;
    return o;
  }

  extra() {
    const ball = this.ball;
    return {
      ball: [Math.round(ball.x), Math.round(ball.y), Math.round(ball.vx), Math.round(ball.vy)],
      s: this.score,
      ...(this.pause > 0 ? { gol: this.lastGoal } : {}),
      ...(this.overtime ? { ot: 1 } : {}),
      ...(this.waitingKick && this.pause <= 0 ? { ko: this.kickoffTeam } : {}),
      ...(this.duration === Infinity ? { el: Math.floor(this.time) } : {}), // sin límite: reloj que sube
    };
  }

  staticInfo() {
    return { field: this.field, goal: this.arco, view: this.box, ballR: BALL_R, posts: this.postList, teams: TEAMS, playerR: PLAYER_R, kickReach: KICK_REACH, circleR: this.circleR };
  }
}

export default Futbol;
