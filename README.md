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

### Cómo está hecho para que no haya lag

Basado en la arquitectura de red de otro juego del equipo (Fulbito):

- **El servidor manda.** Simula la partida a **60 Hz con paso fijo** y le manda a todos snapshots chicos (< 1 KB con 20 jugadores) **60 veces por segundo**.
- **El cliente manda solo intención:** la dirección **cuando cambia** y la embestida en el mismo `keydown`; el servidor la aplica apenas llega.
- **Sin buffer de interpolación:** los demás se dibujan en su última posición, extrapolada con su velocidad, sin retraso agregado.
- **Tu blob se predice localmente** con la misma física (`public/game/`) y se corrige contra el servidor, así que responde al instante.
- Nagle apagado, sin compresión por mensaje, keepalive con ping de protocolo, try/catch por sala y límite de mensajes por conexión.
- **El ping de cada uno** se ve en el lobby y arriba durante la partida (verde < 60 ms, amarillo < 120, rojo más).

Lo que más pesa igual es **dónde está el servidor**: tiene que estar cerca de los jugadores (ver abajo).

## Correrlo

```bash
npm install
npm start          # http://localhost:3000  (PORT=xxxx para cambiar el puerto)
```

## Publicarlo

Es un único proceso Node con el estado en memoria: **una sola instancia**, sin base de datos ni build.

### Oracle Cloud Always Free, Santiago de Chile (recomendado, gratis)

Medido desde Buenos Aires: ~30 ms de ida y vuelta (Render en EE.UU.: ~220 ms).

1. Crear la cuenta en [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) eligiendo **Chile Central (Santiago)** como *home region* (no se puede cambiar después; lo gratis solo corre en la home region). Pide tarjeta para verificar identidad, no cobra.
2. **Compute → Instances → Create instance**: imagen **Ubuntu 24.04**, shape *Always Free* (`VM.Standard.E2.1.Micro` o `VM.Standard.A1.Flex`), subir tu clave SSH pública.
3. En la **Subnet → Security List**, agregar *Ingress rules* TCP **80** y **443** desde `0.0.0.0/0`.
4. Entrar por SSH (`ssh ubuntu@<ip-publica>`) y correr:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Santisola/Time-to-break/main/deploy/oracle-setup.sh | sudo bash
   ```

   Instala Node, el servicio y Caddy con HTTPS automático, y al final imprime la URL (`https://<ip>.sslip.io`, o tu dominio con `DOMAIN=...`).
5. Para actualizar después de un push, el mismo comando. Ojo: reinicia el servidor y corta las salas abiertas.

### Otras opciones

- **Render** (respaldo): servicio web desde el repo con build `npm install` y start `npm start`. Anda, pero desde Argentina tiene ~220 ms.
- **Cualquier VPS o hosting con Node o Docker** cerca de los jugadores (hay un `Dockerfile`).

## Sumar un juego nuevo

1. `public/game/<nombre>.js`: una clase que extiende `BaseMode` (`public/game/base.js` ya trae movimiento, embestida, choques, paredes y bordes). Implementa `tick(dt, frozen)`, `isDone()` y `results()` → `{ title, lines, points }`, y opcionalmente `extra()` (datos por snapshot), `reliableExtra()` (datos que se acumulan entre snapshots) y `staticInfo()` (datos fijos de la ronda).
2. Registrarla en `public/game/modes.js`.
3. En `public/client.js`: agregarla a `MODES` (tarjeta del lobby) y dibujar su fondo en `frame()`, en la parte de `drawSumo/drawInfeccion/drawPintada`.

## Estructura

```
server.js            HTTP estático + WebSocket + loop a 60 Hz para todas las salas
src/room.js          sala: jugadores, host, fases, puntajes y la partida (paso fijo, snapshots)
public/game/         la simulación, compartida: el servidor la corre y el cliente la usa para predecir
public/client.js     UI, dibujo (canvas), extrapolación de los demás y predicción del blob propio
deploy/              script de instalación para Oracle Cloud (o cualquier Ubuntu)
```
