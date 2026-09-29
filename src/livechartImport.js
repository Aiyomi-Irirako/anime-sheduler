import { DateTime } from 'luxon';
import { fetchLiveChartHtml } from './livechartHttp.js';
import { liveChartScheduleTarget, parseLiveChartMetadata } from './livechart.js';
import { buildDiscoveredSeries, hasUpcomingGermanRelease } from './livechartCatalog.js';

// This loader only returns a draft; saving and enabling announcements remains a separate action.
export async function fetchLiveChartSeriesDraft(scheduleLink, {
  settings = {}, fetchHtml = fetchLiveChartHtml, now = DateTime.now()
} = {}) {
  const target = liveChartScheduleTarget(scheduleLink);
  const detailHtml = await fetchHtml(target.animeUrl, { ttlMs: 24 * 3600000 });
  const metadata = parseLiveChartMetadata(detailHtml, target.animeUrl);
  if (!metadata.title || /^LiveChart\.me$/i.test(metadata.title)) {
    throw new Error('No series title could be read from LiveChart. Check the link and try again.');
  }
  const scheduleHtml = await fetchHtml(target.schedulesUrl);
  const germanSettings = { ...settings, preferredScheduleLanguage: 'de', enabledLanguageCodes: ['de'] };
  const selection = { scheduleId: target.scheduleId };
  const source = { scheduleLink: target.scheduleLink, liveChartLanguageStrict: true, liveChartImportLanguage: 'de' };
  if (!hasUpcomingGermanRelease(scheduleHtml, germanSettings, now, selection)) {
    if (target.scheduleId) {
      throw new Error('The selected schedule has no upcoming German subtitle or dub release. Choose a matching schedule or use the anime link for manual scheduling.');
    }
    // Old catalogue titles may have an announced release that LiveChart does not list yet.
    // Do not replace any user-entered service, schedule, track, or activation fields.
    return { ...metadata, ...source, scheduleMode: 'manual' };
  }
  return {
    ...buildDiscoveredSeries({ ...metadata, scheduleLink: target.scheduleLink }, scheduleHtml,
      detailHtml, germanSettings, now, selection),
    ...source, scheduleMode: 'livechart'
  };
}
