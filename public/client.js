(() => {
  const W = 1600;
  const H = 900;
  const R = 22;

  const MODES = [
    { key: 'sumo', emoji: '🫧', title: 'Sumo de blobs', desc: 'Empujá a todos fuera de la plataforma, que se va achicando. Gana el último en pie.' },
    { key: 'infeccion', emoji: '🧟', title: 'Infección', desc: 'Los zombies contagian con solo tocarte. Aguantá vivo hasta que se acabe el tiempo.' },
    { key: 'pintada', emoji: '🎨', title: 'Pintada', desc: 'Pintá el piso con el color de tu equipo. Gana el que cubre más área.' },
  ];

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {}
    },
  };

  // Clave por pestaña (sessionStorage): sobrevive a un F5 para recuperar puntos,
  // pero dos pestañas del mismo navegador son dos jugadores distintos.
  let key = null;
  let reloaded = false;
  try {
    key = sessionStorage.getItem('ttb-key');
    reloaded = !!key;
    if (!key) {
      key = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('ttb-key', key);
    }
  } catch {
    key = Math.random().toString(36).slice(2);
  }

  const S = {
    ws: null,
    me: null,
    code: null,
    name: '',
    room: null,
    round: null,
    snap: null,
    ents: new Map(),
    grid: null,
    results: null,
    feed: [],
    selected: 'sumo',
    fallen: new Map(),
    look: new Map(),
  };

  // Predicción local de tu blob: se mueve al instante con la misma física que el servidor
  // y se corrige de a poco comparando contra donde estabas hace un RTT.
  const P = { active: false, x: 0, y: 0, vx: 0, vy: 0, dashCd: 0, dashQueued: false, cooldown: 1.4, speed: 1, stun: false, hist: [], rtt: 0, ox: 0, oy: 0, dashT: 0, hitBy: new Map() };

  window.__ttb = { S, P }; // para depurar desde la consola

  const isHost = () => S.room && S.room.hostId === S.me;
  const playerById = (id) => S.room?.players.find((p) => p.id === id);
  const isTouch = matchMedia('(pointer: coarse)').matches;

  // ---------- Inicio ----------
  const params = new URLSearchParams(location.search);
  $('name').value = store.get('ttb-name') || '';
  $('code').value = (params.get('sala') || '').toUpperCase();
  ($('name').value ? $('code').value ? $('join') : $('create') : $('name')).focus();

  function homeMsg(text) {
    $('homeMsg').textContent = text;
  }

  function go(kind) {
    const name = $('name').value.trim();
    if (!name) return homeMsg('Poné tu nombre');
    const code = $('code').value.trim().toUpperCase();
    if (kind === 'join' && code.length !== 4) return homeMsg('El código tiene 4 letras');
    store.set('ttb-name', name);
    S.name = name;
    S.pending = kind === 'join' ? { t: 'join', code, name, key } : { t: 'create', name, key };
    homeMsg('Conectando…');
    connect();
  }

  $('create').onclick = () => go('create');
  $('join').onclick = () => go('join');
  $('name').addEventListener('keydown', (e) => e.key === 'Enter' && go($('code').value ? 'join' : 'create'));
  $('code').addEventListener('keydown', (e) => e.key === 'Enter' && go('join'));
  // F5 en medio de una sala: volver a entrar directo.
  if (reloaded && $('name').value && $('code').value) go('join');

  function connect() {
    if (S.ws) {
      S.ws.onclose = null;
      S.ws.close();
    }
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    S.ws = ws;
    ws.onopen = () => {
      $('conn').classList.add('hidden');
      ws.send(JSON.stringify(S.code ? { t: 'join', code: S.code, name: S.name, key } : S.pending));
    };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      if (S.ws !== ws || S.kicked) return;
      if (S.code) {
        $('conn').classList.remove('hidden');
        setTimeout(connect, 1500);
      } else {
        homeMsg('No se pudo conectar con el servidor');
      }
    };
  }

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  // ---------- Mensajes ----------
  function onMessage(m) {
    switch (m.t) {
      case 'joined':
        S.me = m.id;
        S.code = m.code;
        history.replaceState(null, '', `?sala=${m.code}`);
        $('home').classList.add('hidden');
        homeMsg('');
        break;
      case 'kicked':
        S.kicked = true;
        $('conn').textContent = 'Abriste el juego en otra pestaña. Recargá para jugar acá.';
        $('conn').classList.remove('hidden');
        break;
      case 'error':
        if (m.code === 'noroom' && S.code) {
          S.code = null;
          S.room = null;
          S.round = null;
          $('home').classList.remove('hidden');
          ui();
        }
        if (!$('home').classList.contains('hidden')) homeMsg(m.msg);
        else toast(m.msg);
        break;
      case 'room':
        S.room = m;
        if (m.phase === 'lobby') {
          S.round = null;
          S.results = null;
        }
        if (m.mode && !S.selectedByMe) S.selected = m.mode;
        ui();
        break;
      case 'round':
        P.active = false;
        S.round = m;
        S.snap = null;
        S.ents.clear();
        S.fallen.clear();
        S.feed = [];
        S.results = null;
        S.grid = m.info.grid ? Uint8Array.from(m.info.grid) : null;
        ui();
        break;
      case 's':
        onSnapshot(m);
        break;
      case 'eco': {
        const sample = performance.now() - m.c;
        P.rtt = P.rtt ? P.rtt * 0.75 + sample * 0.25 : sample;
        break;
      }
      case 'results':
        S.results = m;
        ui();
        break;
    }
  }

  // Sin buffer de interpolación: se dibuja el último estado, extrapolado con la velocidad de cada uno.
  function onSnapshot(m) {
    if (!S.round) return;
    const now = performance.now();
    m.at = now;
    // Tuplas [id, x, y, vx, vy, flags, cooldown, equipo] → objetos (ver BaseMode.snapshot).
    m.b = m.b.map(([i, x, y, vx, vy, f, c, tm]) => ({ i, x, y, vx, vy, o: f & 1, d: f & 2, s: f & 4, z: f & 8, c, tm }));
    for (const o of m.b) {
      const e = S.ents.get(o.i);
      if (e) {
        // Lo que se estaba dibujando vs. el dato nuevo: esa diferencia se disuelve en ~60 ms en vez de saltar.
        const shown = entityPos(e, now);
        const ox = shown.x - o.x;
        const oy = shown.y - o.y;
        const far = Math.hypot(ox, oy) > 120;
        S.ents.set(o.i, { ...o, at: now, ox: far ? 0 : ox, oy: far ? 0 : oy });
      } else {
        S.ents.set(o.i, { ...o, at: now, ox: 0, oy: 0 });
      }
    }
    if (m.v) {
      const mine = m.b.find((b) => b.i === S.me);
      if (mine) [mine.sp, mine.dc] = m.v;
    }
    if (m.g && S.grid) for (let i = 0; i < m.g.length; i += 2) S.grid[m.g[i]] = m.g[i + 1];
    for (const text of m.ev || []) S.feed.push({ text, at: now });
    S.snap = m;
    reconcile(m);
    hud(m);
  }

  const EXTRAPOLATE_MAX = 0.1; // no adivinar más de 100 ms si se atrasa un snapshot
  const SMOOTH_MS = 60;

  function entityPos(e, now) {
    const age = Math.min(EXTRAPOLATE_MAX, (now - e.at) / 1000);
    const fade = Math.exp(-(now - e.at) / SMOOTH_MS);
    const moving = !e.o;
    return {
      x: e.x + (moving ? e.vx * age : 0) + e.ox * fade,
      y: e.y + (moving ? e.vy * age : 0) + e.oy * fade,
    };
  }

  function sendServer(msg) {
    if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(msg));
  }

  // ---------- Paneles ----------
  function ui() {
    const phase = S.room?.phase;
    const inRound = phase === 'countdown' || phase === 'playing';
    $('panel').classList.toggle('hidden', !S.room || inRound);
    $('hud').classList.toggle('hidden', !inRound);
    $('center').classList.toggle('hidden', !inRound);
    $('endBtn').classList.toggle('hidden', !(inRound && isHost()));
    $('touchDash').classList.toggle('hidden', !(inRound && isTouch));
    if (S.room && !inRound) renderPanel();
  }

  // Ping de cada jugador con el servidor: verde < 60 ms, amarillo < 120, rojo arriba.
  function pingTag(rtt) {
    if (rtt == null) return '';
    const cls = rtt < 60 ? 'p2p' : rtt < 120 ? 'relay' : 'bad';
    return `<span class="net ${cls}" title="Latencia con el servidor">${rtt} ms</span>`;
  }

  function renderPanel() {
    const r = S.room;
    const host = isHost();
    const players = [...r.players].sort((a, b) => b.score - a.score || a.id - b.id);
    const online = players.filter((p) => p.connected).length;
    const mode = MODES.find((m) => m.key === S.selected) || MODES[0];
    const hostName = playerById(r.hostId)?.name || 'el host';

    let html = '<div class="card panel-card">';
    if (r.phase === 'results' && S.results) {
      const res = S.results;
      const title = MODES.find((m) => m.key === res.mode)?.title || '';
      html += `<div class="results">
        <div class="tag">${esc(title)} · resultado</div>
        <h2>${esc(res.title)}</h2>
        ${res.lines.map((l) => `<p>${esc(l)}</p>`).join('')}
        <ul class="pts">${res.round
          .filter((p) => p.pts > 0)
          .map((p) => `<li><span class="dot" style="background:${p.color}"></span>${esc(p.name)} <b>+${p.pts}</b></li>`)
          .join('')}</ul>
      </div>`;
    }
    html += `<div class="cols">
      <div>
        <div class="roomcode"><span>Sala</span><b>${esc(r.code)}</b><button class="btn small" id="copy">Copiar link</button></div>
        <h3>Jugadores conectados: ${online}</h3>
        <ol class="players">${players
          .map(
            (p, i) => `<li class="${p.id === S.me ? 'me' : ''} ${p.connected ? '' : 'off'}">
              <span class="rank">${i + 1}</span>
              <span class="dot" style="background:${p.color}"></span>
              <span class="nm">${esc(p.name)}${p.id === r.hostId ? ' 👑' : ''}${p.id === S.me ? ' (vos)' : ''}</span>
              ${p.connected ? pingTag(p.rtt) : ''}
              <span class="sc">${p.score}</span>
            </li>`
          )
          .join('')}</ol>
      </div>
      <div>
        <h3>${host ? 'Elegí el juego' : 'Juegos'}</h3>
        <div class="modes">${MODES.map(
          (m) => `<button class="mode ${m.key === mode.key ? 'sel' : ''}" data-k="${m.key}" ${host ? '' : 'disabled'}>
            <span class="em">${m.emoji}</span><b>${m.title}</b><small>${m.desc}</small>
          </button>`
        ).join('')}</div>
        ${
          host
            ? `<button class="btn primary big" id="start">¡Jugar ${esc(mode.title)}!</button>`
            : `<p class="wait">Esperando a que ${esc(hostName)} arranque el próximo juego…</p>`
        }
        ${host && r.phase === 'results' ? '<div class="host-row"><button class="btn small" id="toLobby">Ocultar resultado</button></div>' : ''}
        <p class="keys">${isTouch ? 'Arrastrá el dedo para moverte · 💨 para embestir' : 'Moverse: WASD o flechas · Embestida: Espacio'}</p>
      </div>
    </div></div>`;

    const panel = $('panel');
    const scroll = panel.firstElementChild?.scrollTop || 0;
    panel.innerHTML = html;
    panel.firstElementChild.scrollTop = scroll;

    $('copy').onclick = () => {
      const link = `${location.origin}${location.pathname}?sala=${r.code}`;
      navigator.clipboard?.writeText(link).then(
        () => toast('Link copiado 👍'),
        () => prompt('Copiá el link:', link)
      ) ?? prompt('Copiá el link:', link);
    };
    panel.querySelectorAll('.mode').forEach((btn) => {
      btn.onclick = () => {
        S.selected = btn.dataset.k;
        S.selectedByMe = true;
        renderPanel();
      };
    });
    if ($('start')) $('start').onclick = () => sendServer({ t: 'start', mode: S.selected });
    if ($('toLobby')) $('toLobby').onclick = () => sendServer({ t: 'lobby' });
  }

  $('endBtn').onclick = () => sendServer({ t: 'end' });

  // ---------- HUD ----------
  const hudCache = {};
  function setHud(id, html) {
    if (hudCache[id] === html) return;
    hudCache[id] = html;
    $(id).innerHTML = html;
  }

  function hud(snap) {
    const round = S.round;
    if (!round) return;
    const mins = Math.floor(snap.tl / 60);
    setHud('hudMode', esc(round.title));
    setHud('hudTime', `${mins}:${String(snap.tl % 60).padStart(2, '0')}`);
    $('hudTime').classList.toggle('low', snap.ph === 'playing' && snap.tl <= 10);

    const mine = snap.b.find((b) => b.i === S.me);
    let info = '';
    let banner = '';
    if (round.mode === 'sumo') {
      info = `Quedan <b>${snap.b.filter((b) => !b.o).length}</b>/${snap.b.length}`;
    } else if (round.mode === 'infeccion') {
      const z = snap.b.filter((b) => b.z).length;
      info = `🧑 <b>${snap.b.length - z}</b> · 🧟 <b>${z}</b>`;
      if (mine?.z) banner = '🧟 Sos zombie: ¡contagiá a todos!';
    } else if (round.mode === 'pintada' && snap.x?.c) {
      const total = round.info.cols * round.info.rows;
      info = snap.x.c
        .map((c, t) => `<span class="teambar"><i style="background:${round.info.teams[t].color}"></i>${Math.round((c / total) * 100)}%</span>`)
        .join('');
      if (mine) banner = '';
    }
    setHud('hudInfo', info);
    const ping = Math.round(P.rtt);
    setHud('hudPing', P.rtt ? `<span class="net ${ping < 60 ? 'p2p' : ping < 120 ? 'relay' : 'bad'}">${ping} ms</span>` : '');
    $('banner').classList.toggle('hidden', !banner);
    setHud('banner', esc(banner));

    $('dash').classList.toggle('hidden', !mine || !!mine.o);
    if (mine) {
      const ready = P.active ? 1 - P.dashCd / P.cooldown : 1 - (mine.c || 0) / 9;
      $('dash').querySelector('i').style.width = `${ready * 100}%`;
    }

    let center = '';
    if (snap.ph === 'countdown') {
      let team = '';
      if (round.mode === 'pintada' && mine) {
        const t = round.info.teams[mine.tm];
        team = `<div class="help">Sos del equipo <b style="color:${t.color}">${esc(t.name)}</b></div>`;
      }
      if (round.mode === 'infeccion' && mine?.z) team = '<div class="help">🧟 <b>Arrancás de zombie</b></div>';
      center = `<div class="big">${snap.cd}</div><div class="title">${esc(round.title)}</div><div class="help">${esc(round.help)}</div>${team}`;
    } else if (!mine) {
      center = '<div class="note">👀 Estás mirando: entrás en la próxima ronda</div>';
    } else if (mine.o) {
      center = '<div class="note">🫠 ¡Afuera! Mirá cómo termina</div>';
    }
    setHud('center', center);

    const now = performance.now();
    S.feed = S.feed.filter((f) => now - f.at < 4500).slice(-5);
    setHud('feed', S.feed.map((f) => `<div>${esc(f.text)}</div>`).join(''));
  }

  // ---------- Input ----------
  const keys = new Set();
  let lastSent = '';
  let lastSentAt = 0;
  const joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
  window.__ttb.joy = joy;

  function direction() {
    let x = 0;
    let y = 0;
    if (joy.id !== null) {
      x = joy.x;
      y = joy.y;
    } else {
      x = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
      y = (keys.has('s') || keys.has('arrowdown') ? 1 : 0) - (keys.has('w') || keys.has('arrowup') ? 1 : 0);
    }
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }

  // Intención de movimiento: sale en el mismo evento en que cambia (y un latido cada 2 s).
  function sendInput(force) {
    const phase = S.room?.phase;
    if (!S.ws || S.ws.readyState !== 1 || (phase !== 'countdown' && phase !== 'playing')) return;
    const d = direction();
    const x = Math.round(d.x * 100) / 100;
    const y = Math.round(d.y * 100) / 100;
    const sig = `${x},${y}`;
    const now = performance.now();
    if (!force && sig === lastSent && now - lastSentAt < 2000) return;
    lastSent = sig;
    lastSentAt = now;
    sendServer({ t: 'in', x, y });
  }

  // Acción: directo desde el evento de teclado; el servidor la aplica al llegar.
  function dash() {
    if (P.active) P.dashQueued = true;
    sendInput();
    if (S.room?.phase === 'playing') sendServer({ t: 'dash' });
  }

  // Medición de latencia (eco): alimenta la predicción, el ping del HUD y el del lobby.
  setInterval(() => {
    if (S.ws?.readyState === 1 && S.me) sendServer({ t: 'eco', c: performance.now(), r: P.rtt ? Math.round(P.rtt) : null });
  }, 2000);

  // ---------- Predicción ----------
  function reconcile(snap) {
    const mine = snap.b.find((b) => b.i === S.me);
    if (!mine || mine.o || snap.ph !== 'playing') {
      P.active = false;
      P.dashQueued = false;
      return;
    }
    P.stun = !!mine.s;
    P.speed = mine.sp || 1;
    P.cooldown = mine.dc || 1.4;
    const reset = () => {
      Object.assign(P, { x: mine.x, y: mine.y, vx: mine.vx, vy: mine.vy, ox: 0, oy: 0, hist: [] });
    };
    if (!P.active) {
      P.active = true;
      P.dashCd = 0;
      return reset();
    }
    // Si la predicción estuvo frenada (pestaña de fondo, rAF pausado), no hay historia con qué comparar:
    // tomar directo la posición del servidor.
    if (!P.lastStep || performance.now() - P.lastStep > 250) return reset();
    // El estado que manda el servidor incluye tus teclas de hace ~1 RTT (+ ~8 ms de espera al próximo paso):
    // se compara con lo que se predijo para ese momento.
    const target = performance.now() - P.rtt - 8;
    let past = null;
    for (const h of P.hist) {
      if (h.t > target) break;
      past = h;
    }
    if (!past) return;
    const ex = mine.x - past.x;
    const ey = mine.y - past.y;
    P.err = Math.hypot(ex, ey); // para depurar: cuánto se equivocó la predicción
    if (Math.hypot(ex, ey) > 160) return reset();
    // Corrección completa e inmediata (un empujón se siente apenas llega); lo que se dibuja se desliza
    // hacia la posición corregida en ~50 ms para que no salte.
    const fix = { x: ex, y: ey, vx: mine.vx - past.vx, vy: mine.vy - past.vy };
    for (const s of [P, ...P.hist]) {
      s.x += fix.x;
      s.y += fix.y;
      s.vx += fix.vx;
      s.vy += fix.vy;
    }
    P.ox -= fix.x;
    P.oy -= fix.y;
  }

  function predictStep(dt, now, others) {
    const phys = S.round.phys;
    const inp = P.stun ? { x: 0, y: 0 } : direction();
    P.dashCd = Math.max(0, P.dashCd - dt);
    if (P.dashQueued) {
      P.dashQueued = false;
      let dx = inp.x;
      let dy = inp.y;
      if (!dx && !dy) {
        const s = Math.hypot(P.vx, P.vy);
        if (s > 20) {
          dx = P.vx / s;
          dy = P.vy / s;
        }
      }
      const len = Math.hypot(dx, dy);
      if (!P.stun && P.dashCd <= 0 && len > 0) {
        P.vx += (dx / len) * phys.dashPow;
        P.vy += (dy / len) * phys.dashPow;
        P.dashCd = P.cooldown;
        P.dashT = 0.25;
      }
    }
    P.dashT = Math.max(0, (P.dashT || 0) - dt);
    // Mismo frenado exponencial que el servidor (BaseMode.move).
    const k = 1 - Math.exp(-phys.grip * dt);
    P.vx += (inp.x * phys.maxV * P.speed - P.vx) * k;
    P.vy += (inp.y * phys.maxV * P.speed - P.vy) * k;
    P.x += P.vx * dt;
    P.y += P.vy * dt;

    // Choques con los demás: la misma respuesta que BaseMode.collide, aplicada solo a tu blob
    // (a los demás los mueve el servidor). Rebote al instante en vez de esperar la ida y vuelta.
    for (const o of others) {
      if (o.o || o.i === S.me) continue;
      const dx = o.x - P.x;
      const dy = o.y - P.y;
      const d = Math.hypot(dx, dy);
      if (!d || d >= R * 2) continue;
      const nx = dx / d;
      const ny = dy / d;
      P.x -= nx * (R * 2 - d); // el otro no se mueve acá: salir del todo
      P.y -= ny * (R * 2 - d);
      const rv = (o.vx - P.vx) * nx + (o.vy - P.vy) * ny;
      if (rv < 0) {
        const imp = (-(1 + phys.bounce) * rv) / 2;
        P.vx -= imp * nx;
        P.vy -= imp * ny;
      }
      if (phys.dashBoost) {
        if (P.dashT > 0) P.dashT = 0; // tu embestida se gasta en el impacto
        // Su embestida te empuja una sola vez por choque.
        if (o.d && now - (P.hitBy.get(o.i) || 0) > 300) {
          P.hitBy.set(o.i, now);
          P.vx -= nx * phys.dashBoost;
          P.vy -= ny * phys.dashBoost;
        }
      }
    }
    for (const w of S.round.info.walls || []) {
      const cx = Math.max(w.x, Math.min(P.x, w.x + w.w));
      const cy = Math.max(w.y, Math.min(P.y, w.y + w.h));
      const dx = P.x - cx;
      const dy = P.y - cy;
      const d = Math.hypot(dx, dy);
      if (d >= R || d === 0) continue;
      P.x += (dx / d) * (R - d);
      P.y += (dy / d) * (R - d);
      const vn = (P.vx * dx + P.vy * dy) / d;
      if (vn < 0) {
        P.vx -= (1.3 * vn * dx) / d;
        P.vy -= (1.3 * vn * dy) / d;
      }
    }
    if (phys.bounded) {
      P.x = Math.max(R, Math.min(W - R, P.x));
      P.y = Math.max(R, Math.min(H - R, P.y));
    }
    P.hist.push({ t: now, x: P.x, y: P.y, vx: P.vx, vy: P.vy });
    P.lastStep = now;
    const fade = Math.exp(-dt / 0.05);
    P.ox *= fade;
    P.oy *= fade;
    while (P.hist.length && now - P.hist[0].t > 1500) P.hist.shift();
  }

  const GAME_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'shift'];
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (!GAME_KEYS.includes(k)) return;
    if (S.round) e.preventDefault();
    if ((k === ' ' || k === 'shift') && !e.repeat) dash();
    keys.add(k);
    sendInput();
  });
  addEventListener('keyup', (e) => {
    keys.delete(e.key.toLowerCase());
    sendInput();
  });
  addEventListener('blur', () => {
    keys.clear();
    sendInput();
  });
  setInterval(sendInput, 50);

  const cv = $('cv');
  cv.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    if (joy.id !== null || !S.round) return;
    Object.assign(joy, { id: t.identifier, ox: t.clientX, oy: t.clientY, x: 0, y: 0 });
  }, { passive: true });
  cv.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== joy.id) continue;
      const dx = (t.clientX - joy.ox) / 50;
      const dy = (t.clientY - joy.oy) / 50;
      const len = Math.hypot(dx, dy);
      joy.x = len > 1 ? dx / len : dx;
      joy.y = len > 1 ? dy / len : dy;
      sendInput();
    }
  }, { passive: true });
  const endTouch = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === joy.id) {
        joy.id = null;
        sendInput(true);
      }
    }
  };
  cv.addEventListener('touchend', endTouch);
  cv.addEventListener('touchcancel', endTouch);
  $('touchDash').addEventListener('touchstart', (e) => {
    e.preventDefault();
    dash();
  });

  // ---------- Dibujo ----------
  const ctx = cv.getContext('2d');

  // Posición a dibujar de cada jugador: último snapshot + extrapolación (ver entityPos).
  function currentBodies(now) {
    return S.snap.b.map((o) => ({ ...o, ...entityPos(S.ents.get(o.i), now) }));
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function drawSumo(extra, now) {
    const { cx, cy, r0 } = S.round.info;
    const r = extra?.r ?? r0;
    for (let i = 0; i < 70; i++) {
      const sx = (i * 397) % W;
      const sy = (i * 211) % H;
      ctx.fillStyle = `rgba(255,255,255,${0.15 + 0.15 * Math.sin(now / 600 + i)})`;
      ctx.fillRect(sx, sy, 3, 3);
    }
    ctx.strokeStyle = 'rgba(118,70,221,0.45)';
    ctx.setLineDash([14, 14]);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, r0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 26, r, r * 0.98, 0, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
    g.addColorStop(0, '#fbe9cf');
    g.addColorStop(1, '#efcf9f');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 12;
    ctx.strokeStyle = r < r0 * 0.995 ? `hsl(${16 + 6 * Math.sin(now / 150)},96%,${55 + 8 * Math.sin(now / 150)}%)` : '#c98d4b';
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(160,100,40,0.35)';
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(10, r * 0.55), 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawInfeccion() {
    ctx.fillStyle = '#1b2036';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 2;
    for (let x = 0; x <= W; x += 50) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = 0; y <= H; y += 50) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    for (const w of S.round.info.walls) {
      ctx.fillStyle = '#0b0d1a';
      roundRect(w.x, w.y + 8, w.w, w.h, 8);
      ctx.fill();
      ctx.fillStyle = '#4a5288';
      roundRect(w.x, w.y, w.w, w.h, 8);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      roundRect(w.x + 4, w.y + 4, w.w - 8, Math.min(10, w.h - 8), 4);
      ctx.fill();
    }
    ctx.strokeStyle = '#4a5288';
    ctx.lineWidth = 8;
    ctx.strokeRect(-4, -4, W + 8, H + 8);
  }

  function drawPintada(extra, now) {
    const { cell, cols, rows, teams } = S.round.info;
    ctx.fillStyle = '#e9ebf5';
    ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = S.grid[r * cols + c];
        if (!v) continue;
        ctx.fillStyle = teams[v - 1].color;
        ctx.fillRect(c * cell, r * cell, cell + 0.5, cell + 0.5);
      }
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 1;
    for (let c = 0; c <= cols; c++) {
      ctx.beginPath();
      ctx.moveTo(c * cell, 0);
      ctx.lineTo(c * cell, H);
      ctx.stroke();
    }
    for (let r = 0; r <= rows; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * cell);
      ctx.lineTo(W, r * cell);
      ctx.stroke();
    }
    ctx.strokeStyle = '#4a5288';
    ctx.lineWidth = 8;
    ctx.strokeRect(-4, -4, W + 8, H + 8);

    for (const [, x, y] of extra?.k || []) {
      const bob = Math.sin(now / 200 + x) * 5;
      const pulse = 1 + Math.sin(now / 150) * 0.08;
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.beginPath();
      ctx.ellipse(x, y + 22, 18, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.translate(x, y + bob);
      ctx.scale(pulse, pulse);
      const g = ctx.createConicGradient(now / 400, 0, 0);
      teams.forEach((t, i) => g.addColorStop(i / teams.length, t.color));
      g.addColorStop(1, teams[0].color);
      ctx.fillStyle = g;
      ctx.strokeStyle = '#1b1d36';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-15, -12);
      ctx.lineTo(15, -12);
      ctx.lineTo(11, 16);
      ctx.lineTo(-11, 16);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -12, 13, Math.PI, 0);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawBody(o, now, scale) {
    const round = S.round;
    const player = playerById(o.i);
    let color = player?.color || '#ccc';
    if (round.mode === 'pintada') color = round.info.teams[o.tm].color;
    if (o.z) color = '#5f7f3a';

    let size = 1;
    let alpha = 1;
    if (o.o) {
      if (!S.fallen.has(o.i)) S.fallen.set(o.i, now);
      const k = (now - S.fallen.get(o.i)) / 700;
      if (k >= 1) return;
      size = 1 - k;
      alpha = 1 - k * 0.7;
    }

    const look = S.look.get(o.i) || { x: o.x, y: o.y, dx: 0, dy: 1 };
    const mx = o.x - look.x;
    const my = o.y - look.y;
    const ml = Math.hypot(mx, my);
    if (ml > 0.5) {
      look.dx += (mx / ml - look.dx) * 0.25;
      look.dy += (my / ml - look.dy) * 0.25;
    }
    look.x = o.x;
    look.y = o.y;
    S.look.set(o.i, look);
    const dl = Math.hypot(look.dx, look.dy) || 1;
    const dx = look.dx / dl;
    const dy = look.dy / dl;

    const r = R * size;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(o.x, o.y);

    if (o.d) {
      for (let i = 1; i <= 3; i++) {
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha * (0.25 - i * 0.06);
        ctx.beginPath();
        ctx.arc(-dx * i * 14, -dy * i * 14, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = alpha;
    }

    if (!o.o) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(0, r * 0.85, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (o.z) {
      const aura = ctx.createRadialGradient(0, 0, r * 0.6, 0, 0, r * 2);
      aura.addColorStop(0, `rgba(230,40,60,${0.45 + 0.15 * Math.sin(now / 180 + o.i)})`);
      aura.addColorStop(1, 'rgba(230,40,60,0)');
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(0, 0, r * 2, 0, Math.PI * 2);
      ctx.fill();
    }

    if (o.i === S.me) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.lineDashOffset = -now / 40;
      ctx.beginPath();
      ctx.arc(0, 0, r + 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const squash = 1 + Math.sin(now / 120 + o.i) * 0.03;
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * squash, r / squash, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath();
    ctx.ellipse(-r * 0.35, -r * 0.4, r * 0.3, r * 0.18, -0.5, 0, Math.PI * 2);
    ctx.fill();

    const px = -dy;
    const py = dx;
    for (const side of [-1, 1]) {
      const ex = dx * r * 0.3 + px * side * r * 0.32;
      const ey = dy * r * 0.3 + py * side * r * 0.32 - r * 0.1;
      const er = r * (o.z && side === 1 ? 0.24 : 0.28);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(ex, ey, er, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = o.z ? '#d62839' : '#1a1a2e';
      ctx.beginPath();
      ctx.arc(ex + dx * er * 0.4, ey + dy * er * 0.4, er * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (o.s) {
      ctx.font = '16px system-ui';
      ctx.textAlign = 'center';
      for (let i = 0; i < 3; i++) {
        const a = now / 200 + (i * Math.PI * 2) / 3;
        ctx.fillText('⭐', Math.cos(a) * r, -r - 6 + Math.sin(a) * 5);
      }
    }

    if (!o.o) {
      const fs = Math.max(17, 13 / scale);
      ctx.font = `600 ${fs}px Fredoka, system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const label = player?.name || '?';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(10,10,25,0.85)';
      ctx.strokeText(label, 0, -r - 8);
      ctx.fillStyle = o.i === S.me ? '#ffd166' : '#fff';
      ctx.fillText(label, 0, -r - 8);
    }
    ctx.restore();
  }

  function drawIdle(now, cw, ch) {
    for (let i = 0; i < 14; i++) {
      const x = ((i * 173 + now * 0.02 * (1 + (i % 3))) % (cw + 200)) - 100;
      const y = ch * ((i * 0.37) % 1) + Math.sin(now / 900 + i) * 30;
      const r = 18 + (i % 4) * 8;
      ctx.fillStyle = `hsla(${(i * 137) % 360},80%,62%,0.18)`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawJoystick() {
    if (joy.id === null) return;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(joy.ox, joy.oy, 50, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath();
    ctx.arc(joy.ox + joy.x * 50, joy.oy + joy.y * 50, 22, 0, Math.PI * 2);
    ctx.fill();
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dpr = Math.min(2, devicePixelRatio || 1);
    const cw = innerWidth;
    const ch = innerHeight;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f1020';
    ctx.fillRect(0, 0, cw, ch);

    const inRound = S.round && S.snap && (S.room?.phase === 'countdown' || S.room?.phase === 'playing');
    if (!inRound) return drawIdle(now, cw, ch);

    const top = 56;
    const scale = Math.min((cw - 16) / W, (ch - top - 12) / H);
    const ox = (cw - W * scale) / 2;
    const oy = top + (ch - top - H * scale) / 2;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);

    const bodies = currentBodies(now);
    const extra = S.snap.x;
    const dt = Math.min(0.05, (now - (frame.last || now)) / 1000);
    frame.last = now;
    const mineIdx = bodies.findIndex((o) => o.i === S.me);
    if (mineIdx >= 0 && P.active) {
      predictStep(dt, now, bodies);
      bodies[mineIdx] = { ...bodies[mineIdx], x: P.x + P.ox, y: P.y + P.oy };
    }
    if (S.round.mode === 'sumo') drawSumo(extra, now);
    else if (S.round.mode === 'infeccion') drawInfeccion();
    else if (S.round.mode === 'pintada') drawPintada(extra, now);

    bodies.sort((a, b) => (b.o || 0) - (a.o || 0) || a.y - b.y);
    for (const o of bodies) drawBody(o, now, scale);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawJoystick();
  }
  requestAnimationFrame(frame);
})();
