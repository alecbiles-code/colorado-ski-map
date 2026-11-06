// Every overlay layer, in panel order within each group.
import {avalancheModelLayers} from './avalanche-model.js';
import {forecastLayers} from './forecast.js';
import {historyLayers} from './history.js';
import {routesLayers} from './routes.js';
import {snowLayers} from './snow.js';

export const overlayLayers = () => [...avalancheModelLayers(), ...forecastLayers(), ...historyLayers(), ...routesLayers(), ...snowLayers()];
