// Para sumar un juego: crear la clase en esta carpeta (extendiendo BaseMode) y registrarla acá.
// El cliente también lista los modos en public/client.js (MODES) y los dibuja en drawWorld().
module.exports = {
  sumo: { Mode: require('./sumo'), minPlayers: 1 },
  infeccion: { Mode: require('./infeccion'), minPlayers: 2 },
  pintada: { Mode: require('./pintada'), minPlayers: 1 },
};
