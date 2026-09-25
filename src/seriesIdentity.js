import { liveChartId } from './livechartHttp.js';

export function seriesIdentity(series) {
  return {
    liveChartId: liveChartId(series.scheduleLink),
    malId: String(series.malId || '').trim(),
    title: String(series.title || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
  };
}

export function findDuplicateSeries(entries, candidate, excludeId) {
  const identity = seriesIdentity(candidate);
  const others = entries.filter((entry) => !excludeId || entry.id !== excludeId);
  // Stable source IDs take precedence over matching titles.
  for (const field of ['liveChartId', 'malId']) {
    if (!identity[field]) continue;
    const match = others.find((entry) => seriesIdentity(entry)[field] === identity[field]);
    if (match) return match;
  }
  if (!identity.title) return null;
  return others.find((entry) => {
    const other = seriesIdentity(entry);
    if (identity.liveChartId && other.liveChartId && identity.liveChartId !== other.liveChartId) return false;
    if (identity.malId && other.malId && identity.malId !== other.malId) return false;
    return identity.title === other.title;
  }) || null;
}
