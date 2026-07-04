// TfL-flavoured dark theme.
export const colors = {
  bg: '#0A0E1A',
  card: '#141A2E',
  cardBorder: '#232C4A',
  text: '#F2F4FA',
  textDim: '#8B93AD',
  accent: '#0019A8', // TfL corporate blue
  accentBright: '#4D6BFF',
  good: '#2ECC71',
  warn: '#E67E22',
  bad: '#E74C3C',
};

export const spacing = { xs: 4, s: 8, m: 16, l: 24, xl: 32 };

// Official TfL line colours, keyed by line id from stations.json.
export const lineColors: Record<string, string> = {
  bakerloo: '#B36305',
  central: '#E32017',
  circle: '#FFD300',
  district: '#00782A',
  'hammersmith-city': '#F3A9BB',
  jubilee: '#A0A5A9',
  metropolitan: '#9B0056',
  northern: '#000000',
  piccadilly: '#003688',
  victoria: '#0098D4',
  'waterloo-city': '#95CDBA',
  dlr: '#00A4A7',
  'elizabeth-line': '#6950A1',
  liberty: '#5D6061',
  lioness: '#FAA61A',
  mildmay: '#0077AD',
  suffragette: '#5BBD72',
  weaver: '#823A62',
  windrush: '#ED1B00',
};
