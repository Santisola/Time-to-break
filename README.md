# Time to Break 🫧🧟🎨

Jueguitos multijugador por navegador para el Time to Break del viernes. Funcionan con 1 a 24 jugadores, tienen rondas de 1 a 2 minutos y no hace falta instalar nada.

## Juegos

| Modo | Cómo se juega | Duración |
|---|---|---|
| **Sumo de blobs** | Empujá a todos fuera de la plataforma, que se achica con el tiempo. Gana el último en pie. | hasta 90 s |
| **Infección** | Arranca 1 zombie cada 6 jugadores, y contagian tocando. Sobreviví hasta el final. Necesita 2 o más jugadores. | 100 s |
| **Pintada** | Equipos (2, o 4 si son 12 o más) pintan el piso. Los baldes manchan un área grande. | 90 s |

Controles: **WASD o flechas** para moverse y **Espacio** para embestir. En celular se arrastra el dedo para moverse y se toca el botón 💨 para embestir.

Los puntos se acumulan entre rondas, y el ranking de la sala dura toda la reunión.

## Cómo se juega en la reunión

1. Alguien abre la página, pone su nombre y toca **Crear sala**. Esa persona es el host 👑.
2. Comparte el link con **Copiar link** en el chat de la meet.
3. El host elige el juego y le da a **Jugar**. Entre ronda y ronda aparecen los resultados y el host elige el siguiente.

Si alguien se cae o recarga la página, vuelve a entrar con el mismo link y mantiene sus puntos. El host tiene 8 segundos para volver antes de que la corona pase a otro jugador.

## Correrlo

```bash
npm install
npm start          # http://localhost:3000  (PORT=xxxx para cambiar el puerto)
```

Para jugar con gente de afuera de tu red hay que publicarlo. Es un único proceso Node con WebSockets, sin base de datos ni build.

### Fly.io (recomendado: servidor en São Paulo, ~40 ms desde Argentina)

La configuración está en `fly.toml` + `Dockerfile`. La primera vez:

```bash
curl -L https://fly.io/install.sh | sh          # instala flyctl
fly auth login
fly launch --copy-config --no-deploy --name <nombre-unico>   # usa el fly.toml del repo
fly deploy --ha=false
```

Después, cada cambio: `fly deploy --ha=false`.

> **Una sola máquina.** Las salas viven en memoria: con 2 máquinas la gente quedaría repartida y no se encontraría. Por eso `--ha=false`. Si `fly status` muestra más de una, `fly scale count 1`.

La máquina se apaga sola cuando no hay nadie y tarda unos segundos en arrancar con la primera visita.

### Otras opciones

- **Render / Railway**: servicio web desde el repo con build `npm install` y start `npm start`. Solo tienen servidores en EE.UU., Europa y Asia (~200 ms desde Argentina).
- **Rápido para probar**: `npx cloudflared tunnel --url http://localhost:3000` desde tu máquina te da una URL pública temporal.

## Sumar un juego nuevo

1. `src/modes/<nombre>.js`: una clase que extiende `BaseMode` (`src/modes/base.js` ya trae movimiento, embestida, choques, paredes y bordes). Implementa `tick(dt, frozen)`, `isDone()` y `results()` → `{ title, lines, points }`, y opcionalmente `extra()` (datos por tick) y `staticInfo()` (datos fijos de la ronda).
2. Registrarla en `src/modes/index.js`.
3. En `public/client.js`: agregarla a `MODES` (tarjeta del lobby) y dibujar su fondo en `frame()`, en la parte de `drawSumo/drawInfeccion/drawPintada`.

## Estructura

```
server.js            HTTP estático + WebSocket + loop a 30 Hz
src/room.js          sala: jugadores, host, fases (lobby → countdown → playing → results), puntajes
src/modes/           un archivo por juego + base.js con la física compartida
public/              cliente (canvas + interpolación de snapshots)
```
