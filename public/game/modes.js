// Para sumar un juego: crear la clase en esta carpeta (extendiendo BaseMode) y registrarla acá.
// El cliente también lista los modos en public/client.js (MODES) y los dibuja en frame().
import Sumo from './sumo.js';
import Infeccion from './infeccion.js';
import Pintada from './pintada.js';
import Futbol from './futbol.js';

export const MODES = {
  sumo: { Mode: Sumo, minPlayers: 1 },
  infeccion: { Mode: Infeccion, minPlayers: 2 },
  pintada: { Mode: Pintada, minPlayers: 1 },
  futbol: { Mode: Futbol, minPlayers: 1 },
};
