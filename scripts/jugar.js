// `npm run jugar`: levanta el servidor en esta compu y lo publica con un túnel gratuito de Cloudflare
// (sin cuenta ni tarjeta). Imprime el link para pegar en el chat de la meet. Ctrl+C corta todo.
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3000;
const root = path.join(__dirname, '..');

const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT }, stdio: 'inherit' });
const tunnel = spawn('npx', ['-y', 'cloudflared', 'tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let shown = false;
const watch = (chunk) => {
  const text = chunk.toString();
  const url = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (url && !shown) {
    shown = true;
    const line = '─'.repeat(url.length + 4);
    console.log(`\n┌${line}┐\n│  ${url}  │\n└${line}┘`);
    console.log('Pegá ese link en el chat de la meet. Dejá esta terminal abierta mientras juegan (Ctrl+C para cortar).\n');
  }
  const where = text.match(/location=(\w+)/)?.[1];
  if (where) console.log(`Túnel conectado (${where}).`);
  if (/ERR/.test(text)) process.stderr.write(text);
};
tunnel.stdout.on('data', watch);
tunnel.stderr.on('data', watch);

const stop = () => {
  server.kill();
  tunnel.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => {
  console.error(`El servidor se cerró (código ${code}).`);
  tunnel.kill();
  process.exit(code || 1);
});
tunnel.on('exit', (code) => {
  console.error(`El túnel se cerró (código ${code}).`);
  server.kill();
  process.exit(code || 1);
});
