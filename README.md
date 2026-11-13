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

### El host es el servidor

La partida corre **en el navegador del host** y cada jugador se conecta directo con él por WebRTC (en estrella). Así la latencia es la de la conexión entre ustedes y no la de ir y volver hasta un servidor en otro país.

- **El host tiene que tener buena compu y buena conexión** (cable o buen wifi; ~2 Mbps de subida con 20 jugadores). Lo ideal es que sea quien comparte pantalla.
- Puede cambiar de pestaña (por ejemplo a la de Meet): la simulación corre en un Web Worker y no se frena.
- Si el host se va a mitad de ronda, la ronda se corta y la corona pasa a otro. Los puntajes acumulados se mantienen.
- En el lobby, al lado de cada jugador dice **directo** (WebRTC) o **vía servidor**: si una red (firewall, VPN) no deja armar la conexión directa, sus datos pasan por el servidor automáticamente. Juega igual, con más latencia.

## Correrlo

```bash
npm install
npm start          # http://localhost:3000  (PORT=xxxx para cambiar el puerto)
```

Para jugar con gente de afuera de tu red hay que publicarlo. Es un único proceso Node (salas, puntajes y presentación entre navegadores), sin base de datos ni build. Como la partida no pasa por él, dónde esté alojado casi no afecta la latencia.

- **Render** (el que usamos): servicio web desde el repo con build `npm install` y start `npm start`. El plan gratis se duerme a los 15 minutos sin uso: abrir el link un minuto antes de la reunión.
- **Cualquier hosting con Node o Docker** sirve (hay un `Dockerfile`). Tiene que ser **una sola instancia**: las salas viven en memoria.
- **Rápido para probar**: `npx cloudflared tunnel --url http://localhost:3000` desde tu máquina te da una URL pública temporal.

## Sumar un juego nuevo

1. `public/game/<nombre>.js`: una clase que extiende `BaseMode` (`public/game/base.js` ya trae movimiento, embestida, choques, paredes y bordes). Implementa `tick(dt, frozen)`, `isDone()` y `results()` → `{ title, lines, points }`, y opcionalmente `extra()` (datos por tick, se pueden perder), `reliableExtra()` (datos que no se pueden perder) y `staticInfo()` (datos fijos de la ronda).
2. Registrarla en `public/game/modes.js` y agregar su clave a `MODE_KEYS` en `src/room.js`.
3. En `public/client.js`: agregarla a `MODES` (tarjeta del lobby) y dibujar su fondo en `frame()`, en la parte de `drawSumo/drawInfeccion/drawPintada`.

## Estructura

```
server.js            HTTP estático + WebSocket
src/room.js          sala: jugadores, host, fase, puntajes, señalización WebRTC y retransmisión
public/game/         la partida (corre en el navegador del host): un archivo por juego,
                     base.js con la física compartida y worker.js con el loop a 30 Hz
public/net.js        conexiones WebRTC host ↔ jugadores, con respaldo vía servidor
public/host.js       lado host: worker + reparto de snapshots
public/client.js     UI, dibujo (canvas), interpolación y predicción del blob propio
```
