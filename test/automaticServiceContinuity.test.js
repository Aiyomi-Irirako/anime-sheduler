import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { createStore } from '../src/store.js';
import { parseLiveChartEpisodes } from '../src/livechart.js';
import { collectLiveChartServiceEvidence, reconcileLiveChartServices } from '../src/livechartServices.js';
import { fetchLiveChartSeriesDraft } from '../src/livechartImport.js';
import { syncOneSeriesFromLiveChart } from '../src/livechartSync.js';
import { getNextRelease } from '../src/schedule.js';

const now = DateTime.fromISO('2026-11-08T16:10:00', { zone: 'Europe/Berlin' });
const releaseAt = now.set({ hour: 17, minute: 0 });
const base = 'https://www.livechart.me/anime/13497';
const settings = { timeZone: 'Europe/Berlin', preferredScheduleLanguage: 'de', enabledLanguageCodes: ['de'] };
const options = { preferredLanguageCodes: ['de'], enabledLanguageCodes: ['de'],
  requirePreferredLanguage: true, timeZone: settings.timeZone, nowTimestamp: now.toSeconds() };
const track = (role, codes) => `<span data-release-schedule-info-target="${role}"
  data-tracklist-data='${JSON.stringify(Object.fromEntries(codes.map(code => [code, [[code], ['Language']]])))}'>${codes.join(' ')}</span>`;

function row({ id = '20364', provider = 'Animation Digital Network', languages = ['de', 'fr', 'pl'],
  type = 'Simulcast: Subbed', regional = true, released = false, heading = '', episode = 'EP5', at = releaseAt } = {}) {
  return `<article data-controller="release-schedule"><a href="/anime/13497/schedules/${id}"></a>
    <div>${heading || (released ? 'Released' : `<time data-label="${episode}" data-timestamp="${at.toSeconds()}">${episode}</time>`)}
    ${regional ? '<div>This schedule might not apply to your region.</div>' : ''}</div>
    <div title="${type}">${type}</div><span class="lc-text-contextual-accent">${provider}</span>
    ${track('auralTracklist', ['ja'])}${track('textualTracklist', languages)}</article>`;
}

// The observed server response has German ADN data, but English-only CR data.
const serverHtml = () => row() + row({ id: '20365', provider: 'Crunchyroll', languages: ['en'], regional: false });
const detail = '<meta property="og:title" content="Dragon Ball Super: Beerus | LiveChart.me"><div>Episodes 12</div>';
const source = html => parseLiveChartEpisodes(html, options);
const context = { scheduleLink: `${base}/schedules`, service: 'ADN',
  serviceExt: "{'Animation Digital Network': 'Sub', 'Crunchyroll': 'Sub'}" };

async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-automatic-service-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'isolated-db.json'));
  await store.init();
  await store.updateSettings({ ...store.getSettings(), ...settings });
  await store.upsertSeries({ id: 'automatic-services', title: 'Dragon Ball Super: Beerus',
    ...context, preferredService: '', streamingServiceId: 'GT00389311',
    scheduleLink: `${base}/schedules`, scheduleMode: 'livechart', liveChartLanguageStrict: true,
    liveChartImportLanguage: 'de', enabled: true, status: 'airing', weekly: true,
    nextEpisode: 4, nextDate: '2026-11-01', releaseTime: '18:00', releaseDay: 'sunday',
    episodeCount: 12, episodeBatchSize: 1,
    languageTracks: [{ code: 'de', enabled: true, available: false, nextEpisode: null }],
    lastPostedKey: 'automatic-services:main:4:release-time:2026-11-01T17:00:00.000+01:00',
    lastPostedAt: '2026-11-01T17:00:10+01:00', ...overrides });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external request'); });
  const current = () => store.getSeries('automatic-services');
  const sync = (html = serverHtml()) => syncOneSeriesFromLiveChart(store, current(), { now, overwriteSchedule: true,
    fetchEpisodes: async (_, supplied) => parseLiveChartEpisodes(html, supplied) });
  return { store, current, sync };
}

test('provider evidence keeps geo-filtered language lists separate from German release selection', () => {
  const live = source(serverHtml());
  assert.equal(live.service, 'ADN');
  assert.deepEqual(live.serviceEvidence, { active: ['ADN', 'Crunchyroll'], matching: ['ADN'], completed: [] });
  assert.equal(live.nextEpisode, 5);
  assert.equal(live.mainReleaseTimestamp, releaseAt.toSeconds());
  assert.equal(live.dubNextEpisode, null);
});

test('a previously known provider stays listed without reinterpreting its English row as German', () => {
  const live = source(serverHtml());
  assert.equal(reconcileLiveChartServices({ service: 'ADN,Crunchyroll' }, live), 'ADN,Crunchyroll');
  assert.equal(live.service, 'ADN');
  assert.equal(live.nextEpisode, 5);
});

test('the backup-shaped legacy service details restore a known provider but do not guess a cleared preference', async t => {
  const { current, sync } = await setup(t);
  await sync();
  assert.equal(current().service, 'ADN,Crunchyroll');
  assert.equal(current().preferredService, '');
  assert.equal(current().streamingServiceId, 'GT00389311');
});

test('an unknown English-only provider is not added by automatic reconciliation or a new draft', async () => {
  const html = serverHtml() + row({ id: '3', provider: 'Netflix', languages: ['en'], regional: false });
  const live = source(html);
  assert.equal(reconcileLiveChartServices(context, live), 'ADN,Crunchyroll');
  assert.equal(reconcileLiveChartServices({ service: '' }, live), 'ADN');
  const draft = await fetchLiveChartSeriesDraft(base, { settings, now,
    fetchHtml: async url => url === base ? detail : html });
  assert.equal(draft.service, 'ADN');
});

test('existing-series drafts preserve known active providers while keeping their German date source', async () => {
  const draft = await fetchLiveChartSeriesDraft(base, { settings, now, existingSeries: context,
    fetchHtml: async url => url === base ? detail : serverHtml() });
  assert.equal(draft.service, 'ADN,Crunchyroll');
  assert.equal(draft.nextEpisode, 5);
  assert.equal(draft.nextDate, '2026-11-08');
  assert.equal(draft.releaseTime, '17:00');
});

test('a draft for another anime cannot inherit provider knowledge from the previously edited series', async () => {
  const draft = await fetchLiveChartSeriesDraft(base, { settings, now,
    existingSeries: { ...context, scheduleLink: 'https://www.livechart.me/anime/11218/schedules' },
    fetchHtml: async url => url === base ? detail : serverHtml() });
  assert.equal(draft.service, 'ADN');
  assert.equal(draft.nextEpisode, 5);
  assert.equal(draft.scheduleLink, `${base}/schedules`);
});

test('an expired historical German row does not introduce a new provider into a later release', async () => {
  const oldDate = DateTime.fromISO('2023-06-20T18:00:00', { zone: settings.timeZone });
  const nextDate = now.plus({ days: 1 });
  const html = row({ provider: 'Crunchyroll', at: oldDate, regional: false }) +
    row({ id: '2', provider: 'Prime Video', at: nextDate, episode: 'All12EPs', regional: false });
  const live = source(html);
  assert.equal(live.service, 'Prime Video');
  assert.deepEqual(live.serviceEvidence.matching, ['Prime Video']);
  assert.ok(live.serviceEvidence.active.includes('Crunchyroll'));
  const draft = await fetchLiveChartSeriesDraft(base, { settings, now,
    fetchHtml: async url => url === base ? detail : html });
  assert.equal(draft.service, 'Prime Video');
  assert.equal(draft.nextEpisode, 1);
  assert.equal(draft.nextDate, '2026-11-09');
  assert.equal(reconcileLiveChartServices({ service: 'Crunchyroll' }, live), 'Prime Video,Crunchyroll');
});

test('a completed German provider is not retained from an active foreign row during a new German release', () => {
  const html = row({ provider: 'Crunchyroll', released: true, regional: false }) +
    row({ id: '2', provider: 'Crunchyroll', languages: ['en'], regional: false }) +
    row({ id: '3', provider: 'Prime Video', episode: 'All12EPs', regional: false });
  const live = source(html);
  assert.deepEqual(live.serviceEvidence.completed, ['Crunchyroll']);
  assert.deepEqual(live.serviceEvidence.matching, ['Prime Video']);
  assert.equal(reconcileLiveChartServices({ service: 'Crunchyroll', serviceExt: "{'Crunchyroll':'Sub'}" }, live), 'Prime Video');
  assert.equal(live.nextEpisode, 1);
  assert.equal(live.episodeBatchSize, 12);
});

test('matching current German evidence overrides an older completion for the same provider', () => {
  const html = row({ provider: 'Crunchyroll', released: true, regional: false }) +
    row({ id: '2', provider: 'Crunchyroll', regional: false });
  const live = source(html);
  assert.equal(reconcileLiveChartServices({ service: '' }, live), 'Crunchyroll');
});

test('an absent provider is removed even if it remains in saved legacy service details', () => {
  assert.equal(reconcileLiveChartServices(context, source(row())), 'ADN');
});

test('service aliases and safe JSON or quoted legacy mappings are deduplicated', () => {
  const evidence = { active: ['Animation Digital Network', 'Crunchyroll', 'aniverse Channel'], matching: ['ADN'], completed: [] };
  for (const serviceExt of [
    '{"Crunchyroll":"Sub","aniverse Channel":"Dub"}',
    "{'Crunchyroll':'Sub', 'aniverse Channel':'Dub',   }"
  ]) {
    assert.equal(reconcileLiveChartServices({ service: 'Animation Digital Network,ADN', serviceExt },
      { service: 'ADN', serviceEvidence: evidence }), 'ADN,Crunchyroll,Aniverse');
  }
  for (const serviceExt of ["{'Crunchyroll': someFunction()}", "{'Crunchyroll':'Other'}", '{"Crunchyroll":["Sub"]}']) {
    assert.equal(reconcileLiveChartServices({ service: 'ADN', serviceExt }, { service: 'ADN', serviceEvidence: evidence }), 'ADN');
  }
});

test('cinema and physical-media rows do not establish global streaming-provider evidence', () => {
  const evidence = collectLiveChartServiceEvidence([
    { title: 'Theaters: Subbed', isSubbed: true, subtitleCodes: ['de'], services: ['Cinema'], isReleased: false },
    { title: 'Blu-ray/DVD: Subbed', isSubbed: true, subtitleCodes: ['de'], services: ['Physical'], isReleased: false }
  ], ['de']);
  assert.deepEqual(evidence, { active: [], matching: [], completed: [] });
});

test('a release-ended preview is not treated as explicit completion of the full German version', () => {
  const evidence = collectLiveChartServiceEvidence([{ title: 'Streaming: Subbed', isSubbed: true,
    subtitleCodes: ['de'], services: ['Crunchyroll'], isReleased: true, dateLabel: 'Release ended with EP17' }], ['de']);
  assert.deepEqual(evidence.completed, []);
});

test('an explicitly selected schedule scopes provider metadata as well as the release date', () => {
  const live = parseLiveChartEpisodes(serverHtml(), { ...options, scheduleId: '20364' });
  assert.deepEqual(live.serviceEvidence.active, ['ADN']);
  assert.equal(reconcileLiveChartServices(context, live), 'ADN');
});

test('missing service evidence keeps legacy fetch implementations compatible', () => {
  const incoming = 'Animation Digital Network,Crunchyroll';
  assert.equal(reconcileLiveChartServices(context, { service: incoming }), incoming);
  assert.equal(reconcileLiveChartServices(context, {}), '');
});

test('backend sync preserves a known preferred provider and ID while updating from the German ADN schedule', async t => {
  const { store, current, sync } = await setup(t, { service: 'ADN,Crunchyroll', preferredService: 'Crunchyroll' });
  const before = structuredClone(current());
  await sync();
  assert.equal(current().service, 'ADN,Crunchyroll');
  assert.equal(current().preferredService, 'Crunchyroll');
  assert.equal(current().streamingServiceId, before.streamingServiceId);
  assert.equal(current().lastPostedKey, before.lastPostedKey);
  assert.equal(current().lastPostedAt, before.lastPostedAt);
  assert.equal(current().nextEpisode, 5);
  assert.equal(current().nextDate, '2026-11-08');
  assert.equal(current().releaseTime, '17:00');
  assert.equal(getNextRelease(current(), store.getSettings(), now).dateTime.toMillis(), releaseAt.toMillis());
  assert.equal(current().languageTracks.find(track => track.code === 'de').nextEpisode, null);
  assert.equal(store.snapshot().posts.length, 0);
});

test('restored automatic services and their known legacy context survive backup restore and restart', async t => {
  const { store, sync } = await setup(t);
  await sync();
  const reloaded = createStore(store.filePath);
  await reloaded.init();
  await reloaded.replaceData(store.snapshot());
  const restored = reloaded.getSeries('automatic-services');
  assert.equal(restored.service, 'ADN,Crunchyroll');
  assert.equal(restored.preferredService, '');
  assert.equal(restored.serviceExt, context.serviceExt);
});

test('sync uses newly saved provider knowledge and preference when its source request was already in flight', async t => {
  const { store, current } = await setup(t, { serviceExt: '' });
  let resolve, started;
  const gate = new Promise(value => { resolve = value; });
  const waiting = new Promise(value => { started = value; });
  const run = syncOneSeriesFromLiveChart(store, current(), { now, overwriteSchedule: true,
    fetchEpisodes: async (_, supplied) => { started(); await gate; return parseLiveChartEpisodes(serverHtml(), supplied); } });
  await waiting;
  await store.upsertSeries({ ...current(), service: 'ADN,Crunchyroll', preferredService: 'Crunchyroll' });
  resolve();
  await run;
  assert.equal(current().service, 'ADN,Crunchyroll');
  assert.equal(current().preferredService, 'Crunchyroll');
  assert.equal(current().nextEpisode, 5);
  assert.equal(current().releaseTime, '17:00');
});
