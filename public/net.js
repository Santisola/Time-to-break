// Conexiones directas (WebRTC) entre el host y cada jugador, en estrella.
// El servidor solo presenta a las partes (señalización) y retransmite cuando la conexión directa
// no se puede armar (firewalls, VPN): en ese caso todo sigue andando, pero vía servidor.

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const OPEN_TIMEOUT_MS = 10000;
const RETRY_MS = 5000;
const MAX_ATTEMPTS = 3;
const BUFFER_LIMIT = 256 * 1024;

export class Net {
  constructor({ sendServer, onFromHost, onFromPeer, onStatus }) {
    Object.assign(this, { sendServer, onFromHost, onFromPeer, onStatus });
    this.me = null;
    this.hostId = null;
    this.room = null;
    this.links = new Map(); // host: un link por jugador · jugador: un solo link, con el host
    this.retries = new Map(); // id -> { epoch, attempts, at }
    this.status = null;
    setInterval(() => this.room && this.sync(this.room, this.me), 2000);
  }

  get isHost() {
    return this.me !== null && this.me === this.hostId;
  }

  // Se llama con cada mensaje 'room' del servidor.
  sync(room, me) {
    this.room = room;
    this.me = me;
    if (room.hostId !== this.hostId) {
      for (const id of [...this.links.keys()]) this.close(id);
      this.retries.clear();
      this.hostId = room.hostId;
      this.status = null;
      if (!this.isHost) this.watchOpen(this.hostId);
    }
    if (!this.isHost) return;

    const live = new Map(room.players.filter((p) => p.connected && p.id !== me).map((p) => [p.id, p.conn]));
    for (const [id, link] of this.links) if (live.get(id) !== link.epoch) this.close(id);
    const now = Date.now();
    for (const [id, epoch] of live) {
      if (this.links.has(id)) continue;
      const r = this.retries.get(id);
      if (r && r.epoch === epoch && (r.attempts >= MAX_ATTEMPTS || now < r.at)) continue;
      this.offer(id, epoch);
    }
  }

  peerIds() {
    return this.room ? this.room.players.filter((p) => p.connected && p.id !== this.me).map((p) => p.id) : [];
  }

  // ---------- Armado de conexiones ----------
  newLink(id, epoch) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const link = { pc, epoch, open: false, remoteSet: false, pending: [], chain: Promise.resolve() };
    pc.onicecandidate = (e) => e.candidate && this.sendServer({ t: 'sig', to: id, d: { candidate: e.candidate } });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.fail(id, link);
    };
    this.links.set(id, link);
    setTimeout(() => !link.open && this.links.get(id) === link && this.fail(id, link), OPEN_TIMEOUT_MS);
    return link;
  }

  wireChannel(id, link, ch) {
    link[ch.label] = ch;
    ch.onmessage = (e) => this.receive(id, e.data);
    ch.onopen = () => {
      if (link.u?.readyState === 'open' && link.r?.readyState === 'open') {
        link.open = true;
        if (!this.isHost) this.setStatus('p2p');
        else this.onFromPeer(id, { t: 'linked' });
      }
    };
    ch.onclose = () => this.fail(id, link);
  }

  offer(id, epoch) {
    const link = this.newLink(id, epoch);
    this.wireChannel(id, link, link.pc.createDataChannel('u', { ordered: false, maxRetransmits: 0 }));
    this.wireChannel(id, link, link.pc.createDataChannel('r'));
    link.pc
      .createOffer()
      .then((o) => link.pc.setLocalDescription(o))
      .then(() => this.sendServer({ t: 'sig', to: id, d: { sdp: link.pc.localDescription } }))
      .catch(() => this.fail(id, link));
  }

  // Mensajes de señalización que llegan por el servidor.
  signal(from, d) {
    if (!d) return;
    if (!this.isHost) {
      if (from !== this.hostId) return;
      if (d.sdp?.type === 'offer') {
        this.close(from);
        const link = this.newLink(from, null);
        link.pc.ondatachannel = (e) => this.wireChannel(from, link, e.channel);
      }
    }
    const link = this.links.get(from);
    if (!link) return;
    // En orden: la descripción remota tiene que estar antes que los candidatos.
    link.chain = link.chain
      .then(async () => {
        if (d.sdp) {
          await link.pc.setRemoteDescription(d.sdp);
          link.remoteSet = true;
          for (const c of link.pending.splice(0)) await link.pc.addIceCandidate(c).catch(() => {});
          if (d.sdp.type === 'offer') {
            await link.pc.setLocalDescription(await link.pc.createAnswer());
            this.sendServer({ t: 'sig', to: from, d: { sdp: link.pc.localDescription } });
          }
        } else if (d.candidate) {
          if (link.remoteSet) await link.pc.addIceCandidate(d.candidate).catch(() => {});
          else link.pending.push(d.candidate);
        }
      })
      .catch(() => this.fail(from, link));
  }

  // Reconexión al servidor: el host va a ofrecer una conexión nueva; volver a reportar el estado.
  rejoined() {
    this.status = null;
    if (this.hostId !== null && !this.isHost) this.watchOpen(this.hostId);
  }

  watchOpen(hostId) {
    setTimeout(() => {
      if (this.hostId === hostId && !this.isHost && this.status !== 'p2p') this.setStatus('relay');
    }, OPEN_TIMEOUT_MS);
  }

  fail(id, link) {
    if (this.links.get(id) !== link) return;
    this.close(id);
    if (this.isHost) {
      const r = this.retries.get(id);
      const attempts = r && r.epoch === link.epoch ? r.attempts + 1 : 1;
      this.retries.set(id, { epoch: link.epoch, attempts, at: Date.now() + RETRY_MS });
      this.onFromPeer(id, { t: 'unlinked' });
    } else {
      this.setStatus('relay');
    }
  }

  close(id) {
    const link = this.links.get(id);
    if (!link) return;
    this.links.delete(id);
    try {
      link.pc.close();
    } catch {}
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }

  // ---------- Envío y recepción ----------
  sendTo(id, str, reliable) {
    const link = this.links.get(id);
    const ch = link?.open ? (reliable ? link.r : link.u) : null;
    if (ch?.readyState === 'open') {
      if (!reliable && ch.bufferedAmount > BUFFER_LIMIT) return; // conexión saturada: mejor saltear un snapshot
      ch.send(str);
    } else {
      this.sendServer({ t: 'relay', to: id, d: str });
    }
  }

  toHost(msg, reliable = false) {
    if (this.hostId !== null) this.sendTo(this.hostId, JSON.stringify(msg), reliable);
  }

  linkStatus(id) {
    return this.links.get(id)?.open ? 'p2p' : 'relay';
  }

  receive(from, str) {
    let m;
    try {
      m = JSON.parse(str);
    } catch {
      return;
    }
    if (this.isHost) this.onFromPeer(from, m);
    else if (from === this.hostId) this.onFromHost(m);
  }
}
