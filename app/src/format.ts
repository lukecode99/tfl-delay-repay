// Pure display helpers (no RN imports — node-testable).

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-06-10" → "Wednesday 10 June 2026" (no Intl dependence). */
export function formatDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[dow]} ${d} ${MONTHS[m - 1]} ${y}`;
}

export const formatGBP = (v: number) => `£${v.toFixed(2)}`;

/** Group journeys (already sorted date-desc) into SectionList sections. */
export function groupByDay<T extends { date: string }>(items: T[]): { title: string; date: string; data: T[] }[] {
  const sections: { title: string; date: string; data: T[] }[] = [];
  for (const item of items) {
    const last = sections[sections.length - 1];
    if (last && last.date === item.date) last.data.push(item);
    else sections.push({ title: formatDay(item.date), date: item.date, data: [item] });
  }
  return sections;
}
