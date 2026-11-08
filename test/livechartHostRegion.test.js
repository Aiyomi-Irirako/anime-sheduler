import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { parseLiveChartEpisodes } from '../src/livechart.js';
import { buildDiscoveredSeries, hasUpcomingGermanRelease } from '../src/livechartCatalog.js';
import { fetchLiveChartSeriesDraft } from '../src/livechartImport.js';
import { syncOneSeriesFromLiveChart } from '../src/livechartSync.js';
import { createStore } from '../src/store.js';
import { getNextRelease, getNextLanguageRelease, isSeriesComplete } from '../src/schedule.js';

const now = DateTime.fromISO('2026-11-07T22:37:00', { zone: 'Europe/Berlin' });
const releaseAt = DateTime.fromISO('2026-11-14T18:00:00', { zone: 'Europe/Berlin' });
const settings = { timeZone: 'Europe/Berlin', preferredScheduleLanguage: 'de', enabledLanguageCodes: ['de'] };
const options = { timeZone: settings.timeZone, preferredLanguageCodes: ['de'],
  enabledLanguageCodes: ['de'], requirePreferredLanguage: true, nowTimestamp: now.toSeconds() };
const base = 'https://www.livechart.me/anime/13150';
const candidate = { title: 'Even the Student Council Has Its Holes!', scheduleLink: `${base}/schedules`, episodeCount: 12 };
const detail = `<meta property="og:title" content="Even the Student Council Has Its Holes! | LiveChart.me">
  <div>Episodes 12</div><div><div>Premiere</div><time datetime="2026-10-03">Oct 3, 2026</time></div>`;
const warning = 'This schedule might not apply to your region.';
const track = (role, code) => `<span data-release-schedule-info-target="${role}"
  data-tracklist-data='{"${code}":[["${code}"],["Language"]]}'>${code}</span>`;

// Reduced forms of the separate heading and language metadata in schedules 20308/20401.
function row({ id = '20308', type = 'Simulcast: Subbed', code = 'de', dub = false,
  label = 'EP7', at = releaseAt, heading = '', service = 'Animation Digital Network',
  region = true, nestedWarning = false, omitLanguage = false } = {}) {
  const notice = region ? `<div>${warning}</div>` : '';
  return `<article data-controller="release-schedule"><a href="/anime/13150/schedules/${id}"></a>
    <div>${heading || `<time data-label="${label}" data-timestamp="${at.toSeconds()}">${label}</time>`}
    ${nestedWarning ? notice : ''}</div>${nestedWarning ? '' : notice}
    <div title="${type}">${type}</div><span class="lc-text-contextual-accent">${service}</span>
    ${dub ? '' : track('auralTracklist', 'ja')}
    ${omitLanguage ? '' : track(dub ? 'auralTracklist' : 'textualTracklist', code)}</article>`;
}

const germanSchedules = () => row() + row({ id: '20401', service: 'aniverse Channel',
  at: releaseAt.plus({ hours: 1 }), nestedWarning: true });

async function setup(t, series) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-host-region-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'isolated-db.json'));
  await store.init();
  await store.replaceData({ ...store.snapshot(), settings: { ...store.getSettings(), ...settings }, series: [series] });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  const sync = html => syncOneSeriesFromLiveChart(store, store.getSeries(series.id), {
    now, overwriteSchedule: true, fetchEpisodes: async (_, supplied) => parseLiveChartEpisodes(html, supplied)
  });
  return { store, sync, current: () => store.getSeries(series.id) };
}

test('configured German streams keep both real warning layouts independent of the server region', () => {
  const live = parseLiveChartEpisodes(germanSchedules(), options);
  assert.equal(live.nextEpisode, 7);
  assert.equal(live.mainReleaseTimestamp, releaseAt.toSeconds());
  assert.equal(live.mainUnavailable, false);
  assert.equal(live.mainEpisodeUnknown, false);
  assert.equal(live.service, 'ADN,Aniverse');
});

test('a server-region warning is still excluded without an explicit language intent', () => {
  const live = parseLiveChartEpisodes(germanSchedules(), { nowTimestamp: now.toSeconds(), timeZone: settings.timeZone });
  assert.equal(live.nextEpisode, null);
  assert.equal(live.service, '');
});

test('foreign streams and German physical or cinema rows do not supply the configured German stream', () => {
  const inapplicable = row({ id: '1', code: 'en', service: 'HIDIVE', at: now.plus({ days: 1 }) }) +
    row({ id: '2', type: 'Broadcast (Japan)', code: 'ja', at: now.plus({ days: 1 }) }) +
    row({ id: '3', type: 'Theaters: Subbed', service: 'Cinema', at: now.plus({ days: 1 }) }) +
    row({ id: '4', type: 'Blu-ray/DVD: Subbed', service: 'Physical', at: now.plus({ days: 1 }) });
  assert.equal(parseLiveChartEpisodes(inapplicable, options).nextEpisode, null);
  assert.equal(hasUpcomingGermanRelease(inapplicable, settings, now), false);
  const live = parseLiveChartEpisodes(inapplicable + germanSchedules(), options);
  assert.equal(live.mainReleaseTimestamp, releaseAt.toSeconds());
  assert.equal(live.service, 'ADN,Aniverse');
});

test('a matching regional stream with unreadable required language data fails safely', () => {
  const malformed = row({ type: 'Simulcast: Dubbed, Subbed', omitLanguage: true })
    .replace(track('auralTracklist', 'ja'), track('auralTracklist', 'de'));
  assert.throws(() => parseLiveChartEpisodes(malformed + germanSchedules(), options), /languages could not be read/);
});

test('parser, discovery and the general or selected schedule draft agree on warned German streams', async () => {
  const html = germanSchedules();
  assert.equal(hasUpcomingGermanRelease(html, {}, now), true);
  const discovered = buildDiscoveredSeries(candidate, html, detail, settings, now);
  assert.equal(discovered.nextEpisode, 7);
  assert.equal(discovered.nextDate, '2026-11-14');
  assert.equal(discovered.releaseTime, '18:00');
  for (const link of [base, `${base}/schedules/20308`]) {
    const draft = await fetchLiveChartSeriesDraft(link, { settings, now,
      fetchHtml: async url => url === base ? detail : html });
    assert.equal(draft.scheduleMode, 'livechart');
    assert.equal(draft.nextEpisode, 7);
    assert.equal(draft.nextDate, discovered.nextDate);
    assert.equal(draft.releaseTime, discovered.releaseTime);
    assert.equal(draft.liveChartImportLanguage, 'de');
  }
});

test('sync restores the Student Council backup shape without changing IDs or post history', async t => {
  const id = 'even-the-student-council-has-its-holes-a9b21a2d';
  const { store, sync, current } = await setup(t, { id, ...candidate, scheduleMode: 'livechart',
    status: 'planned', enabled: true, nextEpisode: null, nextDate: '', releaseTime: '', releaseDay: '',
    liveChartImportLanguage: 'de', liveChartLanguageStrict: true, streamingServiceId: '1428', tvdbId: '463051',
    lastPostedKey: `${id}:main:5:release-time:2026-10-31T19:00:00.000+01:00`,
    lastPostedAt: '2026-10-31T19:00:35.364+01:00', languageTracks: [] });
  const before = structuredClone(current());
  await sync(germanSchedules());
  assert.equal(current().nextEpisode, 7);
  assert.equal(current().nextDate, '2026-11-14');
  assert.equal(current().releaseTime, '18:00');
  assert.equal(current().releaseDay, 'saturday');
  for (const field of ['id', 'streamingServiceId', 'tvdbId', 'lastPostedKey', 'lastPostedAt']) {
    assert.equal(current()[field], before[field]);
  }
  assert.equal(getNextRelease(current(), store.getSettings(), now).dateTime.toISO(), releaseAt.toISO());
  assert.equal(store.snapshot().posts.length, 0);
});

test('an enabled or already tracked German dub uses its language instead of the host-region warning', () => {
  const html = row({ type: 'Streaming: Dubbed', dub: true, label: 'EP2' });
  for (const intent of [{ enabledLanguageCodes: ['de'] },
    { pendingLanguageTracks: [{ code: 'de', enabled: true, nextEpisode: 2 }] }]) {
    const live = parseLiveChartEpisodes(html, { preferredLanguageCodes: ['en'],
      timeZone: settings.timeZone, nowTimestamp: now.toSeconds(), ...intent });
    assert.equal(live.languageTracks.find(item => item.code === 'de').nextEpisode, 2);
  }
  assert.deepEqual(parseLiveChartEpisodes(html, { nowTimestamp: now.toSeconds() }).languageTracks, []);
});

test('warned German releases without an exact month-day or episode cannot invent a posting date', () => {
  const month = '<time datetime="2026-11-01" data-controller="formatted-temporal" data-formatted-temporal-precision="2">EP2: Nov 2026</time>';
  const html = row({ type: 'Streaming: Dubbed', dub: true, heading: month });
  const live = parseLiveChartEpisodes(html, options);
  const dub = live.languageTracks.find(item => item.code === 'de');
  assert.equal(dub.nextEpisode, 2);
  const discovered = buildDiscoveredSeries(candidate, html, detail, settings, now);
  const discoveredDub = discovered.languageTracks.find(item => item.code === 'de');
  assert.equal(discoveredDub.nextDate, '');
  assert.equal(discoveredDub.releaseTime, '');
  assert.equal(getNextLanguageRelease(discovered, discoveredDub, settings, now), null);
  const unknown = parseLiveChartEpisodes(row({ label: 'TBA' }), options);
  assert.equal(unknown.nextEpisode, null);
  assert.equal(unknown.mainEpisodeUnknown, true);
  assert.equal(unknown.mainReleaseTimestamp, null);
});

function finishedOriginal() {
  const id = 'finished-original-pending-german';
  return { id, ...candidate, scheduleMode: 'livechart', status: 'finished', enabled: true,
    nextEpisode: null, nextDate: '', releaseTime: '', releaseDay: '', liveChartLanguageStrict: true,
    lastPostedKey: `${id}:main:12:release-time:2026-10-01T18:00:00.000+02:00`,
    languageTracks: [{ code: 'de', enabled: true, available: true, nextEpisode: 2,
      nextDate: '2026-11-14', releaseTime: '18:00', releaseDay: 'saturday',
      lastPostedKey: `${id}:language:de:1:release-time:2026-10-31T18:00:00.000+01:00` }] };
}

test('an explicit Released German dub still completes when its warning describes the host region', async t => {
  const { sync, current } = await setup(t, finishedOriginal());
  const priorKey = current().languageTracks.find(item => item.code === 'de').lastPostedKey;
  await sync(row({ heading: 'Released', region: false }) +
    row({ id: '2', type: 'Streaming: Dubbed', dub: true, heading: 'Released' }));
  const dub = current().languageTracks.find(item => item.code === 'de');
  assert.equal(dub.nextEpisode, null);
  assert.equal(dub.lastPostedKey, priorKey);
  assert.equal(isSeriesComplete(current()), true);
  assert.equal(current().releaseCompletionNotices.length, 1);
});

test('an absent German dub still pauses instead of advancing or falsely completing', async t => {
  const { sync, current } = await setup(t, finishedOriginal());
  await sync(row({ heading: 'Released', region: false }) +
    row({ id: '2', type: 'Streaming: Dubbed', code: 'en', dub: true, label: 'EP2' }));
  const dub = current().languageTracks.find(item => item.code === 'de');
  assert.equal(dub.nextEpisode, 2);
  assert.equal(dub.nextDate, '');
  assert.equal(dub.releaseTime, '');
  assert.equal(isSeriesComplete(current()), false);
  assert.deepEqual(current().releaseCompletionNotices, []);
});
