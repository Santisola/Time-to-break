const W = 1600;
const H = 900;
const R = 22;

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// Ubica `count` jugadores en filas de 3 alrededor de (cx, cy).
function cluster(cx, cy, count, gap = 56) {
  const cols = Math.min(3, count);
  const rows = Math.ceil(count / cols);
  return Array.from({ length: count }, (_, i) => ({
    x: cx + ((i % cols) - (cols - 1) / 2) * gap,
    y: cy + (Math.floor(i / cols) - (rows - 1) / 2) * gap,
  }));
}

/**
 * Base de todos los modos: cuerpos circulares que se mueven con inercia, chocan y embisten.
 * Cada modo implementa tick(dt, frozen), isDone(), results() y opcionalmente extra()/staticInfo().
 */
class BaseMode {
  constructor(players) {
    this.time = 0;
    this.duration = 90;
    this.events = [];
    this.phys = { grip: 7, maxV: 260, dashPow: 600, bounded: true };
    this.bodies = shuffle(
      players.map((p) => ({
        id: p.id,
        p,
        x: W / 2,
        y: H / 2,
        vx: 0,
        vy: 0,
        r: R,
        alive: true,
        speed: 1,
        dashCd: 0,
        dashT: 0,
        dashCooldown: 1.4,
        lastDash: p.dashSeq,
        stun: 0,
      }))
    );
  }

  byId(id) {
    return this.bodies.find((b) => b.id === id);
  }

  event(text) {
    this.events.push(text);
  }

  timeLeft() {
    return Math.max(0, this.duration - this.time);
  }

  // El cliente replica esta misma física para predecir su propio blob (public/client.js → predictStep).
  move(dt, frozen) {
    const { grip, maxV, dashPow } = this.phys;
    for (const b of this.bodies) {
      if (!b.alive) continue;
      if (!frozen) {
        b.dashCd = Math.max(0, b.dashCd - dt);
        b.dashT = Math.max(0, b.dashT - dt);
        b.stun = Math.max(0, b.stun - dt);
      }
      const active = !frozen && b.stun <= 0 && b.p.connected;
      const ix = active ? b.p.input.x : 0;
      const iy = active ? b.p.input.y : 0;

      if (b.p.dashSeq !== b.lastDash) {
        b.lastDash = b.p.dashSeq;
        let dx = ix;
        let dy = iy;
        if (!dx && !dy) {
          const s = Math.hypot(b.vx, b.vy);
          if (s > 20) {
            dx = b.vx / s;
            dy = b.vy / s;
          }
        }
        const len = Math.hypot(dx, dy);
        if (active && b.dashCd <= 0 && len > 0) {
          b.vx += (dx / len) * dashPow;
          b.vy += (dy / len) * dashPow;
          b.dashCd = b.dashCooldown;
          b.dashT = 0.25;
        }
      }

      const k = Math.min(1, grip * dt);
      b.vx += (ix * maxV * b.speed - b.vx) * k;
      b.vy += (iy * maxV * b.speed - b.vy) * k;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
  }

  // Choques entre jugadores. onTouch(a, b, impacto) se llama por cada par que se toca.
  collide(onTouch, { bounce = 0.6, dashBoost = 0 } = {}) {
    const list = this.bodies.filter((b) => b.alive);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const min = a.r + b.r;
        let d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        if (d2 < 0.0001) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const ny = dy / d;
        const overlap = (min - d) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;

        const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rv < 0) {
          const imp = (-(1 + bounce) * rv) / 2;
          a.vx -= imp * nx;
          a.vy -= imp * ny;
          b.vx += imp * nx;
          b.vy += imp * ny;
        }
        if (dashBoost) {
          if (a.dashT > 0) {
            b.vx += nx * dashBoost;
            b.vy += ny * dashBoost;
            a.dashT = 0;
          }
          if (b.dashT > 0) {
            a.vx -= nx * dashBoost;
            a.vy -= ny * dashBoost;
            b.dashT = 0;
          }
        }
        if (onTouch) onTouch(a, b, Math.max(0, -rv));
      }
    }
  }

  walls(rects) {
    for (const b of this.bodies) {
      if (!b.alive) continue;
      for (const w of rects) {
        const cx = Math.max(w.x, Math.min(b.x, w.x + w.w));
        const cy = Math.max(w.y, Math.min(b.y, w.y + w.h));
        const dx = b.x - cx;
        const dy = b.y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 >= b.r * b.r) continue;
        let nx, ny, pen;
        if (d2 > 0.0001) {
          const d = Math.sqrt(d2);
          nx = dx / d;
          ny = dy / d;
          pen = b.r - d;
        } else {
          const sides = [
            [b.x - w.x, -1, 0],
            [w.x + w.w - b.x, 1, 0],
            [b.y - w.y, 0, -1],
            [w.y + w.h - b.y, 0, 1],
          ].sort((s1, s2) => s1[0] - s2[0]);
          [pen, nx, ny] = sides[0];
          pen += b.r;
        }
        b.x += nx * pen;
        b.y += ny * pen;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
          b.vx -= 1.3 * vn * nx;
          b.vy -= 1.3 * vn * ny;
        }
      }
    }
  }

  bounds() {
    for (const b of this.bodies) {
      if (!b.alive) continue;
      if (b.x < b.r) [b.x, b.vx] = [b.r, Math.abs(b.vx) * 0.3];
      if (b.x > W - b.r) [b.x, b.vx] = [W - b.r, -Math.abs(b.vx) * 0.3];
      if (b.y < b.r) [b.y, b.vy] = [b.r, Math.abs(b.vy) * 0.3];
      if (b.y > H - b.r) [b.y, b.vy] = [H - b.r, -Math.abs(b.vy) * 0.3];
    }
  }

  randomSpot(ok, margin = 60) {
    for (let i = 0; i < 300; i++) {
      const x = margin + Math.random() * (W - margin * 2);
      const y = margin + Math.random() * (H - margin * 2);
      if (ok(x, y)) return { x, y };
    }
    return { x: W / 2, y: H / 2 };
  }

  bodyState(b) {
    const o = { i: b.id, x: Math.round(b.x), y: Math.round(b.y), vx: Math.round(b.vx), vy: Math.round(b.vy) };
    if (b.speed !== 1) o.sp = b.speed;
    if (b.dashCooldown !== 1.4) o.dc = b.dashCooldown;
    if (!b.alive) o.o = 1;
    if (b.dashT > 0) o.d = 1;
    if (b.stun > 0) o.s = 1;
    if (b.dashCd > 0) o.c = Math.ceil((b.dashCd / b.dashCooldown) * 9);
    return o;
  }

  /**
   * Estado por tick que viaja por el canal no confiable (si se pierde uno, llega el siguiente).
   * b: tuplas [id, x, y, flags, cooldown 0-9, equipo] con flags 1=afuera 2=embistiendo 4=aturdido 8=zombie.
   * v: datos que solo necesita cada jugador para predecir su propio blob: [vx, vy, velocidad, cooldown].
   */
  snapshot() {
    const b = [];
    const v = {};
    for (const body of this.bodies) {
      const o = this.bodyState(body);
      b.push([o.i, o.x, o.y, (o.o ? 1 : 0) | (o.d ? 2 : 0) | (o.s ? 4 : 0) | (o.z ? 8 : 0), o.c || 0, o.tm ?? 0]);
      v[o.i] = [o.vx, o.vy, o.sp || 1, o.dc || 1.4];
    }
    return { tl: Math.ceil(this.timeLeft()), b, x: this.extra(), v };
  }

  // Lo que no se puede perder (eventos, celdas pintadas): viaja por el canal confiable.
  reliable() {
    const ev = this.events.splice(0);
    const g = this.reliableExtra();
    return ev.length || g?.length ? { ev, g } : null;
  }

  extra() {
    return null;
  }

  reliableExtra() {
    return null;
  }

  staticInfo() {
    return {};
  }
}

export { BaseMode, W, H, R, shuffle, cluster };
