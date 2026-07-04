// Binds the resolver core to the bundled station dataset.
import { stations } from '../data';
import { makeResolver, normalizeStationName } from './resolve-core';

export { normalizeStationName };
export const resolveStation = makeResolver(stations);
