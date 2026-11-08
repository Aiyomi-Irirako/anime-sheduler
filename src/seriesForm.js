import { LANGUAGE_OPTIONS, normalizeLanguageTracks } from './languages.js';
import { cleanString, parseInteger } from './utils.js';

const strings = ['title', 'service', 'preferredService', 'streamingServiceId', 'tvdbId',
  'premiereDate', 'releaseDay', 'releaseTime', 'nextDate', 'scheduleLink', 'imageUrl',
  'note', 'malId', 'rawRelease', 'liveChartImportLanguage'];
const trackFields = { enabled: 'Enabled', available: 'Available', nextEpisode: 'Episode',
  episodeBatchSize: 'BatchSize', releaseDay: 'ReleaseDay', releaseTime: 'ReleaseTime',
  nextDate: 'NextDate', weekly: 'Weekly' };

export function createSeriesFormBaseline(series) {
  const fields = Object.fromEntries(strings.map(key => [key, cleanString(series[key])]));
  Object.assign(fields, { status: cleanString(series.status) || 'unknown',
    nextEpisode: parseInteger(series.nextEpisode), episodeCount: parseInteger(series.episodeCount),
    episodeBatchSize: series.episodeBatchSize || 1, enabled: series.enabled !== false,
    weekly: series.weekly !== false, scheduleMode: series.scheduleMode === 'manual' ? 'manual' : 'livechart',
    liveChartLanguageStrict: Boolean(series.liveChartLanguageStrict),
    completionAcknowledged: Boolean(series.completionAcknowledged) });
  const saved = new Map(normalizeLanguageTracks(series.languageTracks).map(track => [track.code, track]));
  const codes = new Set([...LANGUAGE_OPTIONS.map(language => language.code), ...saved.keys()]);
  const languageTracks = [...codes].map(code => {
    const track = saved.get(code) || { enabled: false, available: false };
    return { code, enabled: Boolean(track.enabled), available: Boolean(track.available),
      nextEpisode: parseInteger(track.nextEpisode), episodeBatchSize: track.episodeBatchSize || 1,
      nextDate: cleanString(track.nextDate), releaseDay: cleanString(track.releaseDay),
      releaseTime: cleanString(track.releaseTime), weekly: track.weekly !== false };
  });
  return { version: 1, id: series.id, fields, languageTracks };
}

export function mergeSeriesFormInput(current, submitted, rawBaseline, rawChangedFields) {
  // Older clients did not submit a baseline; keep their existing save semantics.
  if (!rawBaseline) return submitted;
  let baseline, changedFields;
  try {
    baseline = JSON.parse(rawBaseline);
    changedFields = rawChangedFields ? JSON.parse(rawChangedFields) : [];
    if (baseline?.version !== 1 || baseline.id !== current.id || !baseline.fields ||
        typeof baseline.fields !== 'object' || Array.isArray(baseline.fields) ||
        !Array.isArray(baseline.languageTracks) || !Array.isArray(changedFields) ||
        baseline.languageTracks.some(track => !track || typeof track.code !== 'string')) throw new Error();
  } catch {
    const error = new Error('The form snapshot is invalid. Reload this entry before saving.');
    error.code = 'INVALID_SERIES_FORM_BASELINE';
    error.status = 400;
    throw error;
  }
  const changed = new Set(changedFields.filter(value => typeof value === 'string'));
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const patch = { id: current.id };
  for (const [key, value] of Object.entries(submitted)) {
    if (['id', 'languageTracks', 'dubbed', 'dubNextEpisode'].includes(key)) continue;
    if (changed.has(key) || !Object.hasOwn(baseline.fields, key) || !equal(value, baseline.fields[key])) patch[key] = value;
  }
  const previousTracks = new Map(baseline.languageTracks.map(track => [track.code, track]));
  const currentCodes = new Set((current.languageTracks || []).map(track => track.code));
  const tracks = [];
  for (const track of submitted.languageTracks || []) {
    const previous = previousTracks.get(track.code);
    const key = track.code.replace(/[^a-z0-9]+/g, '_');
    const update = { code: track.code };
    for (const [property, suffix] of Object.entries(trackFields)) {
      if (!Object.hasOwn(track, property)) continue;
      if (changed.has(`language${suffix}_${key}`) || !previous || !equal(track[property], previous[property])) {
        update[property] = track[property];
      }
    }
    if (Object.keys(update).length > 1) tracks.push(currentCodes.has(track.code) ? update : { ...previous, ...update });
  }
  if (tracks.length) patch.languageTracks = normalizeLanguageTracks(tracks, current.languageTracks);
  return patch;
}
