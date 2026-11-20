# Time to Break 🫧🧟🎨

Jueguitos multijugador por navegador para el Time to Break del viernes. Funcionan con 1 a 24 jugadores, tienen rondas de 1 a 2 minutos y no hace falta instalar nada.

## Juegos

| Modo | Cómo se juega | Duración |
|---|---|---|
| **Sumo de blobs** | Empujá a todos fuera de la plataforma, que se achica con el tiempo. Gana el último en pie. | hasta 90 s |
| **Infección** | Arranca 1 zombie cada 6 jugadores, y contagian tocando. Sobreviví hasta el final. Necesita 2 o más jugadores. | 100 s |
| **Pintada** | Equipos (2, o 4 si son 12 o más) pintan el piso. Los baldes manchan un área grande. | 90 s |
| **Haxblobs** ⚽ | Rojo contra Azul con pelota y arcos. **Espacio (o X) patea**: la pelota tiene que estar en el área alrededor del blob y cuanto más pegada, más fuerte. **Shift embiste** (empuja la pelota o traba). Física calibrada con la de HaxBall. Antes de jugar se abre el **armado del partido**: equipos (se arrastran los nombres entre Rojo, Espectadores y Azul: cada uno el suyo, el host a cualquiera; botones Random y Reset), cancha 1v1/3v3/5v5/7v7, duración y goles. Empate al final: gol de oro. | 2 a 5 min o sin límite |

Controles: **WASD o flechas** para moverse y **Espacio** para embestir (en fútbol: **Shift** embiste y **Espacio** patea). En celular se arrastra el dedo para moverse, 💨 embiste y ⚽ patea.

Los puntos se acumulan entre rondas, y el ranking de la sala dura toda la reunión.

- **🎉 Modo party:** el host lo activa desde la sala. Arranca con la tabla en 0 y va sorteando juegos sin repetir hasta que salieron todos (después se vuelven a mezclar). Entre juego y juego hay 10 s para ver el resultado y arranca el siguiente solo; el host puede adelantarlo o finalizar el party. Haxblobs entra con equipos al azar y la cancha según cuántos son.
- **🏁 Podio:** al finalizar el party, o con "Finalizar Time to Break" desde la sala, todos ven el podio con los 3 primeros y el resto de la tabla (los empatados comparten puesto). Después se puede volver a la sala o empezar una sesión nueva con los puntajes en 0.

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

Lo que más pesa igual es **dónde está el servidor**: tiene que estar cerca de los jugadores. Por eso la forma recomendada es correrlo en Argentina (ver abajo).

## Correrlo

```bash
npm install
npm start          # http://localhost:3000  (PORT=xxxx para cambiar el puerto)
```

## Jugar el viernes (recomendado)

El servidor corre **en la compu de quien organiza**, solo durante la reunión, y se publica con un túnel gratuito de Cloudflare (sin cuenta ni tarjeta):

```bash
npm install        # solo la primera vez
npm run jugar
```

En unos 15 segundos imprime un link tipo `https://palabras-al-azar.trycloudflare.com`: se pega en el chat de la meet y listo. Dejá la terminal abierta mientras juegan; `Ctrl+C` corta todo. Funciona en Linux, macOS y Windows.

El link se muestra recién cuando ya abre desde internet: Cloudflare lo crea unos segundos después de anunciarlo, y si alguien lo abre antes, su DNS se guarda el "no existe" por un minuto.

- **Latencia:** Cloudflare tiene datacenter en Buenos Aires (Ezeiza), así que todo queda en Argentina. Medido: ~10 ms ida y vuelta desde la misma compu; para el resto del equipo, del orden de 15–30 ms.
- El link **cambia cada vez** que se corre.
- Con 20 jugadores el servidor sube ~5 Mbps: conviene fibra o cable.
- La compu no se puede suspender durante la reunión.

## Publicarlo en un servidor fijo (opcional)

Es un único proceso Node con el estado en memoria: **una sola instancia**, sin base de datos ni build. Lo que más pesa es que esté **cerca de los jugadores**.

- **Render** (está publicado en https://time-to-break.onrender.com): anda, pero desde Argentina tiene ~220 ms.
- **Oracle Cloud Always Free, Santiago de Chile** (~30 ms): gratis, pero pide tarjeta para verificar identidad y puede apagar las máquinas sin uso. En una VM Ubuntu, `deploy/oracle-setup.sh` instala todo con HTTPS automático:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/Santisola/Time-to-break/main/deploy/oracle-setup.sh | sudo bash
  ```

  Sin dominio usa `https://<ip>.sslip.io`; con uno (por ejemplo DuckDNS, gratis): `sudo DOMAIN=nombre.duckdns.org bash`. Hay que abrir los puertos 80 y 443 en la Security List de la subnet.
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
scripts/jugar.js     `npm run jugar`: servidor local + túnel de Cloudflare
deploy/              script de instalación para Oracle Cloud (o cualquier Ubuntu)
```
