// National Rail station list for Avanti West Coast and Southern/GTR routes.
// CRS codes are the 3-letter identifiers used by HSP and Darwin APIs.

export interface RailStation {
  crs: string;
  name: string;
  /** Which TOCs serve this station (used to suggest the right claim portal). */
  operators: ReadonlyArray<'avanti' | 'southern' | 'gtr'>;
}

export const RAIL_STATIONS: readonly RailStation[] = [
  // Avanti West Coast main line
  { crs: 'EUS', name: 'London Euston', operators: ['avanti'] },
  { crs: 'MKC', name: 'Milton Keynes Central', operators: ['avanti'] },
  { crs: 'WFJ', name: 'Watford Junction', operators: ['avanti'] },
  { crs: 'RUG', name: 'Rugby', operators: ['avanti'] },
  { crs: 'COV', name: 'Coventry', operators: ['avanti'] },
  { crs: 'BHM', name: 'Birmingham New Street', operators: ['avanti'] },
  { crs: 'WVH', name: 'Wolverhampton', operators: ['avanti'] },
  { crs: 'SHR', name: 'Shrewsbury', operators: ['avanti'] },
  { crs: 'CRE', name: 'Crewe', operators: ['avanti'] },
  { crs: 'SOT', name: 'Stoke-on-Trent', operators: ['avanti'] },
  { crs: 'MAC', name: 'Macclesfield', operators: ['avanti'] },
  { crs: 'SPT', name: 'Stockport', operators: ['avanti'] },
  { crs: 'MAN', name: 'Manchester Piccadilly', operators: ['avanti'] },
  { crs: 'LIV', name: 'Liverpool Lime Street', operators: ['avanti'] },
  { crs: 'PRE', name: 'Preston', operators: ['avanti'] },
  { crs: 'LAN', name: 'Lancaster', operators: ['avanti'] },
  { crs: 'OXF', name: 'Oxford', operators: ['avanti'] },
  { crs: 'CTR', name: 'Chester', operators: ['avanti'] },
  { crs: 'BNG', name: 'Bangor', operators: ['avanti'] },
  { crs: 'HHD', name: 'Holyhead', operators: ['avanti'] },
  { crs: 'GLC', name: 'Glasgow Central', operators: ['avanti'] },
  { crs: 'EDB', name: 'Edinburgh Waverley', operators: ['avanti'] },
  { crs: 'PNZ', name: 'Penrith', operators: ['avanti'] },
  { crs: 'CAR', name: 'Carlisle', operators: ['avanti'] },
  { crs: 'OXP', name: 'Oxenholme Lake District', operators: ['avanti'] },
  { crs: 'LCS', name: 'Lancaster (north)', operators: ['avanti'] },

  // Southern / GTR (Brighton main line and beyond)
  { crs: 'VIC', name: 'London Victoria', operators: ['southern', 'gtr'] },
  { crs: 'LBG', name: 'London Bridge', operators: ['southern', 'gtr'] },
  { crs: 'CLJ', name: 'Clapham Junction', operators: ['southern', 'gtr'] },
  { crs: 'ECR', name: 'East Croydon', operators: ['southern', 'gtr'] },
  { crs: 'RDH', name: 'Redhill', operators: ['southern', 'gtr'] },
  { crs: 'REI', name: 'Reigate', operators: ['southern'] },
  { crs: 'GTW', name: 'Gatwick Airport', operators: ['southern', 'gtr'] },
  { crs: 'TBR', name: 'Three Bridges', operators: ['southern', 'gtr'] },
  { crs: 'CRW', name: 'Crawley', operators: ['southern'] },
  { crs: 'HHE', name: 'Haywards Heath', operators: ['southern', 'gtr'] },
  { crs: 'BUG', name: 'Burgess Hill', operators: ['southern'] },
  { crs: 'HSK', name: 'Hassocks', operators: ['southern'] },
  { crs: 'BTN', name: 'Brighton', operators: ['southern', 'gtr'] },
  { crs: 'HOV', name: 'Hove', operators: ['southern'] },
  { crs: 'WRH', name: 'Worthing', operators: ['southern'] },
  { crs: 'LIT', name: 'Littlehampton', operators: ['southern'] },
  { crs: 'BOG', name: 'Bognor Regis', operators: ['southern'] },
  { crs: 'CHI', name: 'Chichester', operators: ['southern'] },
  { crs: 'PMS', name: 'Portsmouth & Southsea', operators: ['southern'] },
  { crs: 'PMH', name: 'Portsmouth Harbour', operators: ['southern'] },
  { crs: 'EBN', name: 'Eastbourne', operators: ['southern'] },
  { crs: 'LWS', name: 'Lewes', operators: ['southern'] },
  { crs: 'POL', name: 'Polegate', operators: ['southern'] },
  { crs: 'HGS', name: 'Hastings', operators: ['southern'] },
  { crs: 'BAT', name: 'Battle', operators: ['southern'] },
  { crs: 'HRH', name: 'Horsham', operators: ['southern'] },
  { crs: 'AMY', name: 'Amberley', operators: ['southern'] },
  { crs: 'ARU', name: 'Arundel', operators: ['southern'] },
  { crs: 'SUO', name: 'Sutton', operators: ['southern', 'gtr'] },
  { crs: 'EPS', name: 'Epsom', operators: ['southern'] },
  { crs: 'WIM', name: 'Wimbledon', operators: ['southern', 'gtr'] },

  // GTR (Thameslink / Great Northern)
  { crs: 'STP', name: 'St Pancras International', operators: ['gtr'] },
  { crs: 'ZFD', name: 'Farringdon', operators: ['gtr'] },
  { crs: 'BFR', name: 'London Blackfriars', operators: ['gtr'] },
  { crs: 'CTK', name: 'City Thameslink', operators: ['gtr'] },
  { crs: 'KGX', name: "King's Cross", operators: ['gtr'] },
  { crs: 'FPK', name: 'Finsbury Park', operators: ['gtr'] },
  { crs: 'WGC', name: 'Welwyn Garden City', operators: ['gtr'] },
  { crs: 'HIT', name: 'Hitchin', operators: ['gtr'] },
  { crs: 'LET', name: 'Letchworth Garden City', operators: ['gtr'] },
  { crs: 'BDK', name: 'Baldock', operators: ['gtr'] },
  { crs: 'ARL', name: 'Arlesey', operators: ['gtr'] },
  { crs: 'BIG', name: 'Biggleswade', operators: ['gtr'] },
  { crs: 'SBF', name: 'Sandy', operators: ['gtr'] },
  { crs: 'STR', name: 'St Neots', operators: ['gtr'] },
  { crs: 'HUN', name: 'Huntingdon', operators: ['gtr'] },
  { crs: 'PBO', name: 'Peterborough', operators: ['gtr'] },
  { crs: 'LUT', name: 'Luton', operators: ['gtr'] },
  { crs: 'LTN', name: 'Luton Airport Parkway', operators: ['gtr'] },
  { crs: 'WLW', name: 'Welwyn North', operators: ['gtr'] },
  { crs: 'HAT', name: 'Hatfield', operators: ['gtr'] },
  { crs: 'WLY', name: 'Welwyn Garden City', operators: ['gtr'] },
  { crs: 'PNE', name: 'Potters Bar', operators: ['gtr'] },
  { crs: 'BOR', name: 'Borhamwood & Elstree', operators: ['gtr'] },
];

/** Map from CRS code → station for fast lookup. */
const BY_CRS = new Map<string, RailStation>(RAIL_STATIONS.map(s => [s.crs, s]));

export function stationByCrs(crs: string): RailStation | null {
  return BY_CRS.get(crs.toUpperCase()) ?? null;
}

/** Case-insensitive prefix/contains match on station name or CRS. */
export function searchStations(query: string): RailStation[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  // CRS exact match first
  const exact = BY_CRS.get(q.toUpperCase());
  if (exact) return [exact];
  const prefix: RailStation[] = [];
  const contains: RailStation[] = [];
  for (const s of RAIL_STATIONS) {
    const name = s.name.toLowerCase();
    const crs = s.crs.toLowerCase();
    if (name.startsWith(q) || crs.startsWith(q)) prefix.push(s);
    else if (name.includes(q)) contains.push(s);
  }
  return [...prefix, ...contains];
}

/** Infer the most likely TOC for an origin/destination pair. */
export function inferOperator(fromCrs: string, toCrs: string): 'avanti' | 'southern' | 'gtr' | null {
  const from = stationByCrs(fromCrs);
  const to = stationByCrs(toCrs);
  if (!from || !to) return null;
  const common = from.operators.filter(op => to.operators.includes(op));
  if (!common.length) return null;
  // Prefer the more specific operator
  if (common.includes('avanti')) return 'avanti';
  if (common.includes('southern')) return 'southern';
  return common[0] as 'avanti' | 'southern' | 'gtr';
}
