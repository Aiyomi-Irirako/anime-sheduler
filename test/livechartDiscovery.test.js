import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { createStore } from '../src/store.js';
import { createDiscoveryController, discoverySeasons, shouldRunDiscovery, hasExistingSeries } from '../src/livechartDiscovery.js';
import { parseSeasonCatalog, hasUpcomingGermanRelease, buildDiscoveredSeries } from '../src/livechartCatalog.js';
import { createLiveChartClient, liveChartId } from '../src/livechartHttp.js';
import { parseLiveChartEpisodes } from '../src/livechart.js';
import { syncOneSeriesFromLiveChart, prepareLiveMainSchedule, prepareLiveLanguageTracks } from '../src/livechartSync.js';
import { mergeLanguageTracks } from '../src/languages.js';
import { getNextRelease, getNextLanguageRelease } from '../src/schedule.js';
import { createWebApp } from '../src/web.js';

const clock = DateTime.fromISO('2026-09-23T07:00:00', { zone: 'Europe/Berlin' });
const settings = { timeZone: 'Europe/Berlin', preferredScheduleLanguage: 'de', enabledLanguageCodes: ['de'],
  liveChartDiscoveryEnabled: true, liveChartDiscoveryHour: 6, liveChartDiscoverySeason: 'fall-2026' };
const tile = (id = '123', title = `Example ${id}`) => `<article data-anime-id="${id}" data-english="${title}">
  <div class="anime-episodes">12 eps</div><div class="anime-date">October 2026</div>
  <a href="https://myanimelist.net/anime/${id}">MAL</a></article>`;
const tracks = (kind, languages) => `<span><svg><use href="#icon:${kind}"></use></svg></span><span data-tracklist-json="${JSON.stringify(languages).replaceAll('"', '&quot;')}"></span>`;
const schedule = ({ precision = 3, date = '2026-10-04', stamp = '', label = 'EP1',
  subtitle = 'de', audio = 'ja', title = 'Simulcast: Subbed', confirm = false, region = false, service = 'Crunchyroll' } = {}) =>
  `<article data-release-schedule-release-schedule-id="4"><a href="/anime/123/schedules/4" title="${title}">
  ${label} <time ${stamp ? `data-timestamp="${stamp}"` : `data-intl-time-datetime="${date}" data-intl-time-precision="${precision}"`}></time>
  ${confirm ? 'requires confirmation' : ''}${region ? 'might not apply to your region' : ''}</a>
  ${tracks('audio', { [audio]: [audio] })}${tracks('subtitles', { [subtitle]: [subtitle] })}
  <span class="lc-text-contextual-accent">${service}</span></article>`;
const detail = '<div><div>Premiere</div><a>Oct 4, 2026</a></div>';
const candidate = parseSeasonCatalog(tile(), 'fall-2026')[0];

async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-auto-import-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'db.json'));
  await store.init();
  await store.replaceData({ ...store.snapshot(), settings: { ...store.getSettings(), ...settings, ...overrides } });
  return store;
}

test('German subtitles OR German audio qualifies; foreign and released catalogue entries do not', () => {
  for (const options of [{}, { subtitle: 'en', audio: 'de', title: 'Streaming: Dubbed' },
    { label: '', precision: 1, date: '2026-01-01' }, { confirm: true }]) {
    assert.equal(hasUpcomingGermanRelease(schedule(options), settings, clock), true);
  }
  for (const options of [{ subtitle: 'en' }, { subtitle: 'ja', title: 'Broadcast (Japan)' },
    { label: 'Released' }, { date: '2026-09-01' }, { region: true },
    { precision: 2, date: '2026-08-01' }, { precision: 1, date: '2025-01-01' }]) {
    assert.equal(hasUpcomingGermanRelease(schedule(options), settings, clock), false);
  }
  assert.throws(() => hasUpcomingGermanRelease('<html>Broken layout</html>', settings, clock), /could be read/);
});

test('date-only, batch, month/year-only and unknown-episode entries keep safe posting dates', () => {
  for (const precision of [1, 2]) {
    const html = schedule({ precision });
    const result = buildDiscoveredSeries(candidate, html, detail, settings, clock);
    assert.equal(result.enabled, true);
    assert.equal(result.nextDate, '');
    assert.equal(result.releaseDay, '');
    assert.equal(getNextRelease(result, settings, clock), null);
    const live = parseLiveChartEpisodes(html, { preferredLanguageCodes: ['de'], nowTimestamp: clock.toSeconds() });
    assert.deepEqual(prepareLiveMainSchedule(live, settings), { nextDate: '', releaseTime: '', releaseDay: '' });
  }
  const result = buildDiscoveredSeries(candidate, schedule({ label: 'All 12 EPs' }), detail, settings, clock);
  assert.equal(result.nextDate, '2026-10-04');
  assert.equal(result.releaseTime, '');
  assert.equal(result.episodeBatchSize, 12);
  assert.equal(result.weekly, false);
  assert.equal(result.premiereDate, '2026-10-04');
  assert.equal(getNextRelease(result, settings, clock).missingTime, true);
  const unknown = buildDiscoveredSeries(candidate, schedule({ label: '' }), detail, settings, clock);
  assert.equal(unknown.nextEpisode, null);
  assert.equal(getNextRelease(unknown, settings, clock), null);
});

test('automatically adds only German matches to the normal series list without a preview or candidate database', async (t) => {
  const store = await setup(t, { preferredScheduleLanguage: 'en', enabledLanguageCodes: ['en'] });
  const pages = new Map([
    ['101', schedule()], ['102', schedule({ subtitle: 'en', audio: 'de', title: 'Streaming: Dubbed', service: 'Aniverse' })],
    ['103', schedule({ subtitle: 'en' })], ['104', schedule({ subtitle: 'ja', title: 'Broadcast (Japan)' })],
    ['105', schedule({ precision: 2, label: '' })], ['106', schedule({ label: 'Released' })]
  ]);
  const urls = [];
  const controller = createDiscoveryController(store, { now: () => clock, fetchHtml: async (url) => {
    urls.push(url);
    if (url.endsWith('/all')) return [...pages.keys()].map((id) => tile(id)).join('');
    if (url.endsWith('/schedules')) return pages.get(liveChartId(url));
    return detail;
  } });
  assert.deepEqual(await controller.start(), { checked: 6, added: 3, skipped: 3, failed: 0 });
  assert.deepEqual(store.listSeries().map((series) => liveChartId(series.scheduleLink)), ['101', '102', '105']);
  const dub = store.listSeries()[1];
  assert.equal(dub.service, 'Aniverse');
  assert.equal(dub.nextEpisode, null);
  assert.equal(dub.languageTracks[0].code, 'de');
  assert.equal(dub.languageTracks[0].enabled, true);
  assert.equal(dub.liveChartImportLanguage, 'de');
  assert.equal(getNextRelease(dub, settings, clock), null);
  assert.equal(getNextLanguageRelease(dub, dub.languageTracks[0], settings, clock).episode, 1);
  assert.equal(store.getSettings().preferredScheduleLanguage, 'en');
  assert.equal(urls.length, 10); // One overview, six schedules, three German detail pages.
  assert.equal(store.snapshot().changeLog.length, 3);
  assert.ok(store.snapshot().changeLog.every((entry) => entry.source === 'livechart-import'));
  assert.deepEqual(Object.keys(store.getDiscovery()).sort(), ['error', 'lastAttemptAt', 'lastSuccessAt', 'summary']);
});

test('existing LiveChart, MAL and manual-title entries are skipped before fetching and never overwritten', async (t) => {
  const store = await setup(t);
  for (const input of [{ title: 'Manual A', scheduleLink: 'https://www.livechart.me/anime/101/schedules/4' },
    { title: 'Manual B', malId: '102' }, { title: 'Example 103' }]) {
    await store.upsertSeries({ ...input, streamingServiceId: 'KEEP', enabled: false, nextEpisode: 8 });
  }
  const before = JSON.stringify(store.listSeries());
  let requests = 0;
  const controller = createDiscoveryController(store, { now: () => clock, fetchHtml: async () => {
    requests += 1;
    return ['101', '102', '103'].map((id) => tile(id)).join('');
  } });
  assert.equal((await controller.start()).added, 0);
  assert.equal(requests, 1);
  assert.equal(JSON.stringify(store.listSeries()), before);
  assert.equal(hasExistingSeries(store.listSeries(), { ...candidate, id: '101' }), true);
});

test('a later German announcement is picked up on the next daily check, not permanently ignored', async (t) => {
  const store = await setup(t);
  let time = clock, german = false;
  const requests = [];
  const fetchHtml = async (url) => {
    requests.push(url);
    return url.endsWith('/all') ? tile() : url.endsWith('/schedules') ? schedule({ subtitle: german ? 'de' : 'en' }) : detail;
  };
  let controller = createDiscoveryController(store, { fetchHtml, now: () => time });
  assert.equal((await controller.start()).skipped, 1);
  const reloaded = createStore(store.filePath);
  await reloaded.init();
  assert.equal(shouldRunDiscovery(reloaded.getSettings(), reloaded.getDiscovery(), time), false);
  controller = createDiscoveryController(reloaded, { fetchHtml, now: () => time });
  await controller.start();
  assert.match(controller.status().error, /one hour/);
  assert.equal(requests.length, 2);
  german = true;
  time = time.plus({ days: 1 });
  assert.equal(shouldRunDiscovery(settings, reloaded.getDiscovery(), time), true);
  assert.equal((await controller.start()).added, 1);
  time = time.plus({ days: 1 });
  const before = requests.length;
  assert.equal((await controller.start()).checked, 0);
  assert.equal(requests.length - before, 1);
  assert.equal(reloaded.listSeries().length, 1);
  assert.equal(reloaded.snapshot().changeLog.length, 1);
});

test('a concurrent manual import is rechecked after HTTP and is not duplicated', async (t) => {
  const store = await setup(t);
  const controller = createDiscoveryController(store, { now: () => clock, fetchHtml: async (url) => {
    if (url.endsWith('/all')) return tile();
    if (url.endsWith('/schedules')) return schedule();
    await store.upsertSeries({ title: candidate.title, scheduleLink: candidate.scheduleLink, streamingServiceId: 'MANUAL' });
    return detail;
  } });
  assert.equal((await controller.start()).added, 0);
  assert.equal(store.listSeries().length, 1);
  assert.equal(store.listSeries()[0].streamingServiceId, 'MANUAL');
});

test('403 stops remaining requests, prevents overlapping runs and persists the attempt across restarts', async (t) => {
  const store = await setup(t);
  let rejectRequest;
  const urls = [];
  const controller = createDiscoveryController(store, { now: () => clock, fetchHtml: async (url) => {
    urls.push(url);
    if (url.endsWith('/all')) return tile('101') + tile('102');
    return new Promise((_, reject) => { rejectRequest = () => reject(Object.assign(new Error('HTTP 403'), { status: 403 })); });
  } });
  const running = controller.start();
  assert.throws(() => controller.start(), /already running/);
  while (!rejectRequest) await new Promise((resolve) => setImmediate(resolve));
  rejectRequest();
  await running;
  assert.equal(urls.length, 2);
  assert.match(store.getDiscovery().error, /403/);
  const reloaded = createStore(store.filePath);
  await reloaded.init();
  assert.equal(shouldRunDiscovery(settings, reloaded.getDiscovery(), clock), false);
});

test('individual parse failures do not prevent other German imports and do not create phantom series', async (t) => {
  const store = await setup(t);
  const controller = createDiscoveryController(store, { now: () => clock, fetchHtml: async (url) =>
    url.endsWith('/all') ? tile('101') + tile('102') : url.endsWith('/101/schedules') ? '<html>broken</html>' :
      url.endsWith('/102/schedules') ? schedule() : detail });
  assert.deepEqual(await controller.start(), { checked: 2, added: 1, skipped: 0, failed: 1 });
  assert.equal(store.listSeries().length, 1);
  assert.match(store.getDiscovery().error, /Example 101/);
});

test('unconfirmed and unknown dates keep syncing without generating posts; confirmed German schedules become usable', async (t) => {
  const store = await setup(t, { preferredScheduleLanguage: 'en', enabledLanguageCodes: ['en'] });
  const series = await store.upsertSeries({ ...buildDiscoveredSeries(candidate, schedule({ confirm: true }), detail, settings, clock), liveChartImportLanguage: 'de' });
  assert.equal(series.enabled, true);
  assert.equal(getNextRelease(series, settings, clock), null);
  let currentHtml = schedule({ confirm: true });
  const fetchEpisodes = async (_, options) => {
    assert.deepEqual(options.preferredLanguageCodes, ['de']);
    return parseLiveChartEpisodes(currentHtml, options);
  };
  await syncOneSeriesFromLiveChart(store, series, { overwriteSchedule: true, now: clock, fetchEpisodes });
  assert.equal(getNextRelease(store.getSeries(series.id), settings, clock), null);
  currentHtml = schedule();
  await syncOneSeriesFromLiveChart(store, store.getSeries(series.id), { overwriteSchedule: true, now: clock, fetchEpisodes });
  assert.equal(store.getSeries(series.id).nextDate, '2026-10-04');
  assert.equal(store.getSeries(series.id).releaseTime, '');
  currentHtml = schedule({ label: '' });
  await syncOneSeriesFromLiveChart(store, store.getSeries(series.id), { overwriteSchedule: true, now: clock, fetchEpisodes });
  assert.equal(store.getSeries(series.id).nextEpisode, null);
  assert.equal(getNextRelease(store.getSeries(series.id), settings, clock), null);
  currentHtml = schedule({ subtitle: 'en' });
  await syncOneSeriesFromLiveChart(store, store.getSeries(series.id), { overwriteSchedule: true, now: clock, fetchEpisodes });
  assert.equal(getNextRelease(store.getSeries(series.id), settings, clock), null);
});

test('German dub-only unknown and unconfirmed releases cannot post before dates are usable', () => {
  const html = schedule({ subtitle: 'en', audio: 'de', title: 'Streaming: Dubbed', confirm: true });
  const series = buildDiscoveredSeries(candidate, html, detail, settings, clock);
  assert.equal(series.languageTracks[0].enabled, true);
  assert.equal(getNextLanguageRelease(series, series.languageTracks[0], settings, clock), null);
  const live = parseLiveChartEpisodes(html, { nowTimestamp: clock.toSeconds() });
  const incoming = prepareLiveLanguageTracks(live.languageTracks, settings);
  const [track] = mergeLanguageTracks([{ code: 'de', enabled: true, nextEpisode: 1, nextDate: '2026-10-04', releaseTime: '17:00' }], incoming, ['de']);
  assert.equal(track.nextDate, '');
  assert.equal(track.releaseTime, '');
  const unknown = parseLiveChartEpisodes(schedule({ subtitle: 'en', audio: 'de', title: 'Streaming: Dubbed', label: '' }), {
    requirePreferredLanguage: true, preferredLanguageCodes: ['de'], nowTimestamp: clock.toSeconds()
  });
  const [updated] = mergeLanguageTracks([{ code: 'de', enabled: true, nextEpisode: 1, nextDate: '2026-10-04', releaseTime: '17:00' }],
    prepareLiveLanguageTracks(unknown.languageTracks, settings), ['de']);
  assert.equal(updated.nextDate, '');
  assert.equal(updated.releaseTime, '');
});

test('season rollover, settings and state remain bounded without retaining discarded candidates', async (t) => {
  assert.deepEqual(discoverySeasons({}, DateTime.fromISO('2026-12-25')), ['fall-2026', 'winter-2027']);
  assert.equal(shouldRunDiscovery({ ...settings, liveChartDiscoveryEnabled: false }, {}, clock), false);
  assert.equal(shouldRunDiscovery(settings, {}, clock.set({ hour: 5 })), false);
  const store = await setup(t);
  await store.replaceData({ ...store.snapshot(), liveChartDiscovery: { candidates: Array(600).fill(candidate), summary: 'Previous result' } });
  assert.equal('candidates' in store.getDiscovery(), false);
  await Promise.all([store.updateDiscovery({ summary: 'New result' }), store.upsertSeries({ title: 'Concurrent edit' })]);
  const reloaded = createStore(store.filePath);
  await reloaded.init();
  assert.equal(reloaded.listSeries().length, 1);
  assert.equal(reloaded.getDiscovery().summary, 'New result');
});

test('HTTP client serializes, caches, validates URLs and pauses after rate limiting', async () => {
  let time = 1000000, count = 0;
  const waits = [];
  const request = createLiveChartClient({ now: () => time, wait: async (ms) => { waits.push(ms); time += ms; },
    fetchImpl: async () => { count += 1; return new Response('<html>OK</html>'); } });
  await request('https://www.livechart.me/fall-2026/all', { ttlMs: 60000 });
  await request('https://www.livechart.me/fall-2026/all', { ttlMs: 60000 });
  await request('https://www.livechart.me/streams');
  assert.equal(count, 2);
  assert.deepEqual(waits, [6500]);
  await assert.rejects(request('https://livechart.me.evil.invalid/anime/1'), /Only HTTPS/);
  assert.equal(liveChartId('https://livechart.me.evil.invalid/anime/1'), '');
  const blocked = createLiveChartClient({ fetchImpl: async () => { count += 1; return new Response('', { status: 429 }); } });
  await assert.rejects(blocked('https://www.livechart.me/streams'), /429/);
  await assert.rejects(blocked('https://www.livechart.me/streams'), /paused/);
  assert.equal(count, 3);
});

test('existing Settings page starts auto-import, with no extra tab, approval page or import endpoints', async (t) => {
  const store = await setup(t);
  const controller = createDiscoveryController(store, { now: () => clock, fetchHtml: async (url) =>
    url.endsWith('/all') ? tile() : url.endsWith('/schedules') ? schedule() : detail });
  const discord = { enabled: false, listTextChannels: async () => [], listMentionRoles: async () => [] };
  const app = createWebApp(store, discord, process.cwd(), { discovery: controller });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(`${base}/settings`)).text();
  assert.doesNotMatch(html, /href="\/livechart"/);
  assert.match(html, /Automatically add new series with German/);
  assert.equal((await fetch(`${base}/livechart`, { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(`${base}/livechart/prepare`, { method: 'POST' })).status, 404);
  const post = (body) => fetch(`${base}/settings`, { method: 'POST', body: new URLSearchParams(body), redirect: 'manual' });
  await post({ settingsAction: 'discover-livechart', liveChartDiscoveryEnabled: 'on', liveChartDiscoveryHour: '8' });
  await controller.wait();
  assert.equal(store.listSeries().length, 1);
  assert.equal(store.getSettings().liveChartDiscoveryEnabled, true);
  assert.equal(store.getSettings().liveChartDiscoveryHour, 8);
  await post({ liveChartDiscoveryHour: '9' });
  assert.equal(store.getSettings().liveChartDiscoveryEnabled, false);
  assert.equal(store.getSettings().liveChartDiscoveryHour, 9);
  const dashboard = await (await fetch(`${base}/`)).text();
  assert.match(dashboard, /Example 123/);
});
