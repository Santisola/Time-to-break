// `npm run jugar`: levanta el servidor en esta compu y lo publica con un túnel gratuito de Cloudflare
// (sin cuenta ni tarjeta). Muestra el link recién cuando ya abre desde internet. Ctrl+C corta todo.
// Funciona en Linux, macOS y Windows: el binario de cloudflared viene del paquete npm `cloudflared`.
const { spawn } = require('child_process');
const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const path = require('path');
const { bin, install } = require('cloudflared');

const root = path.join(__dirname, '..');

// Usa el 3000 (o PORT); si está ocupado, cualquier puerto libre: el link público no depende del puerto.
function freePort(preferred) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => (preferred ? resolve(freePort(0)) : resolve(0)));
    probe.listen(preferred, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// El link aparece antes de que el nombre exista en el DNS. Si alguien lo consulta en ese momento (un
// navegador, o este mismo chequeo), su DNS responde "no existe" y guarda esa respuesta 60 s, aunque
// un instante después ya funcione. Por eso primero se pregunta a los DNS autoritativos de Cloudflare
// (no guardan respuestas negativas, se les puede preguntar cada segundo) y recién cuando el nombre
// existe se prueba el link de verdad y se muestra.
const NEGATIVE_CACHE_MS = 61000;

async function authoritativeResolver() {
  const ns = await dns.resolveNs('trycloudflare.com');
  const ips = (await Promise.all(ns.map((n) => dns.resolve4(n).catch(() => [])))).flat();
  if (!ips.length) throw new Error('sin DNS autoritativos');
  const resolver = new dns.Resolver({ timeout: 2000, tries: 1 });
  resolver.setServers(ips);
  return resolver;
}

async function waitForDns(host) {
  let resolver;
  try {
    resolver = await authoritativeResolver();
  } catch {
    return sleep(10000); // sin acceso a los autoritativos (DNS filtrado): margen fijo
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      await Promise.any([resolver.resolve4(host), resolver.resolve6(host)]);
      return;
    } catch {}
    await sleep(1000);
  }
}

async function waitUntilPublic(url) {
  await waitForDns(new URL(url).host);
  const deadline = Date.now() + 3 * 60000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return true;
      await sleep(1000); // 530 y similares: el túnel todavía está arrancando
    } catch (e) {
      if (e.cause?.code === 'ENOTFOUND' || e.cause?.code === 'EAI_AGAIN') {
        console.log('El DNS de esta red todavía no conoce el link; reintento en un minuto…');
        await sleep(NEGATIVE_CACHE_MS);
      } else {
        await sleep(1000);
      }
    }
  }
  return false;
}

async function main() {
  if (!fs.existsSync(bin)) {
    console.log('Descargando cloudflared (solo la primera vez)…');
    await install(bin);
  }
  const PORT = await freePort(Number(process.env.PORT) || 3000);

  const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT }, stdio: 'inherit' });
  const tunnel = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let url = null;
  let checking = false;
  const watch = (chunk) => {
    const text = chunk.toString();
    url ||= text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    if (url && !checking && /Registered tunnel connection/.test(text)) {
      checking = true;
      console.log('Preparando el link público (unos segundos)…');
      waitUntilPublic(url).then((ok) => {
        const line = '─'.repeat(url.length + 4);
        console.log(`\n┌${line}┐\n│  ${url}  │\n└${line}┘`);
        console.log(
          ok
            ? 'Listo: pegá ese link en el chat de la meet. Dejá esta terminal abierta mientras juegan (Ctrl+C para cortar).\n'
            : 'No pude confirmar que el link ya abra desde internet. Probalo; si no anda, cortá con Ctrl+C y volvé a correr npm run jugar.\n',
        );
      });
    }
    if (/ERR/.test(text)) process.stderr.write(text);
  };
  tunnel.stdout.on('data', watch);
  tunnel.stderr.on('data', watch);

  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    server.kill();
    tunnel.kill();
    process.exit(code);
  };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  server.on('exit', (code) => {
    if (stopping) return;
    console.error(`El servidor se cerró (código ${code}).`);
    stop(code || 1);
  });
  tunnel.on('error', (e) => {
    console.error(`No se pudo arrancar el túnel: ${e.message}`);
    stop(1);
  });
  tunnel.on('exit', (code) => {
    if (stopping) return;
    console.error(`El túnel se cerró (código ${code}).`);
    stop(code || 1);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
