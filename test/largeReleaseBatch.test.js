import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { MAX_EPISODE_BATCH_SIZE } from '../src/constants.js';
import { createStore } from '../src/store.js';
import { fetchLiveChartSeriesDraft } from '../src/livechartImport.js';
import { fetchLiveChartEpisodes, parseLiveChartEpisodes } from '../src/livechart.js';
import { syncOneSeriesFromLiveChart } from '../src/livechartSync.js';
import { checkDueAnnouncements } from '../src/scheduler.js';
import { createWebApp } from '../src/web.js';

const now = DateTime.fromISO('2026-10-01T18:00:00', { zone: 'Europe/Berlin' });
const beforeRelease = now.minus({ days: 1 });
const animeUrl = 'https://www.livechart.me/anime/11218';
const settings = { timeZone: 'Europe/Berlin', preferredScheduleLanguage: 'de',
  enabledLanguageCodes: ['de'], reminderMinutes: 0, missingTimePostTime: '18:00',
  automaticDiscordPostsEnabled: true };
const germanTrack = { code: 'de', enabled: true, available: true, nextEpisode: 1,
  episodeBatchSize: 120, nextDate: '2026-10-01', releaseTime: '18:00', weekly: false };
const series = { id: 'large-release', title: 'Large catalogue release', service: 'Prime Video',
  scheduleMode: 'manual', scheduleLink: `${animeUrl}/schedules`, enabled: true, status: 'planned',
  nextEpisode: 1, episodeCount: 120, episodeBatchSize: 120,
  nextDate: '2026-10-01', releaseTime: '18:00', weekly: false, languageTracks: [] };

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-large-release-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('anime-large-release-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const filename = path.join(directory, 'db.json');
  const store = createStore(filename);
  await store.init();
  await store.updateSettings({ ...store.getSettings(), ...settings });
  return { store, filename };
}

const detail = '<html><head><meta property="og:title" content="Large catalogue release | LiveChart.me"></head>' +
  '<body><div>Episodes 120</div></body></html>';
const trackMarkup = (type, code) => `<span><svg><use href="#icon:${type}"></use></svg></span>
  <span data-tracklist-json="{&quot;${code}&quot;:[&quot;DE&quot;]}"></span>`;
function row(label, { dub = false, id = '1', stamp = now } = {}) {
  return `<article data-release-schedule-release-schedule-id="${id}">
    <a href="/anime/11218/schedules/${id}" title="Streaming: ${dub ? 'Dubbed' : 'Subbed'}">
      <span data-label="${label}">${label}</span><time data-timestamp="${stamp.toSeconds()}"></time>
    </a>${trackMarkup('subtitles', 'de')}${trackMarkup('audio', dub ? 'de' : 'ja')}
    <span class="lc-text-contextual-accent">Prime Video</span></article>`;
}
function pages(scheduleHtml) {
  return async (url) => {
    if (url === animeUrl) return detail;
    assert.equal(url, `${animeUrl}/schedules`);
    return scheduleHtml;
  };
}
function parse(html) {
  return parseLiveChartEpisodes(html, { preferredLanguageCodes: ['de'], timeZone: 'Europe/Berlin',
    requirePreferredLanguage: true, nowTimestamp: beforeRelease.toSeconds() });
}

test('120-episode original and German batches survive saving, reload and backup restore', async (t) => {
  const { store, filename } = await setup(t);
  await store.upsertSeries({ ...series, languageTracks: [germanTrack] });
  const restored = createStore(filename);
  await restored.init();
  await restored.replaceData(restored.snapshot());
  const saved = restored.getSeries(series.id);
  assert.equal(saved.episodeBatchSize, 120);
  assert.equal(saved.languageTracks.find(track => track.code === 'de').episodeBatchSize, 120);
});

for (const kind of ['main', 'language']) {
  test(`a manual 120-episode ${kind} release posts once and completes without another announcement`, async (t) => {
    const { store, filename } = await setup(t);
    const previousLock = process.env.DISCORD_AUTO_POSTS;
    process.env.DISCORD_AUTO_POSTS = 'true';
    t.after(() => previousLock === undefined ? delete process.env.DISCORD_AUTO_POSTS : process.env.DISCORD_AUTO_POSTS = previousLock);
    await store.upsertSeries({ ...series, ...(kind === 'language'
      ? { nextEpisode: null, status: 'finished', languageTracks: [germanTrack] } : {}) });
    const messages = [];
    const discord = { enabled: true, ready: true,
      async post(message) { messages.push(message.embeds[0].toJSON()); } };
    const noSync = async () => { throw new Error('Manual releases must not request LiveChart'); };
    assert.equal((await checkDueAnnouncements(store, discord, { now, syncSeries: noSync })).posted, 1);
    assert.match(messages[0].fields.find(field => field.name.startsWith('Episode')).value,
      kind === 'language' ? /01-120\/120 \(German\)/ : /01-120\/120/);
    const finished = store.getSeries(series.id);
    assert.equal(finished.enabled, false);
    assert.equal(finished.status, 'finished');
    const release = kind === 'main' ? finished : finished.languageTracks.find(track => track.code === 'de');
    assert.equal(release.nextEpisode, null);
    if (kind === 'main') assert.equal(release.nextDate, '');
    else assert.equal(release.enabled, false);
    assert.match(release.lastPostedKey, /:1-120:/);
    const reloaded = createStore(filename);
    await reloaded.init();
    assert.equal((await checkDueAnnouncements(reloaded, discord,
      { now: now.plus({ minutes: 1 }), syncSeries: noSync })).posted, 0);
    assert.equal(messages.length, 1);
    assert.equal(reloaded.snapshot().posts.length, 1);
  });
}

for (const label of ['All120EPs', 'EP1-120']) {
  test(`LiveChart ${label} imports and syncs all 120 original and German episodes`, async (t) => {
    const { store } = await setup(t);
    const fetchHtml = pages(row(label) + row(label, { dub: true, id: '2' }));
    const draft = await fetchLiveChartSeriesDraft(animeUrl, { settings, now: beforeRelease, fetchHtml });
    assert.equal(draft.episodeCount, 120);
    assert.equal(draft.episodeBatchSize, 120);
    assert.equal(draft.languageTracks.find(track => track.code === 'de').episodeBatchSize, 120);
    const saved = await store.upsertSeries({ ...draft, episodeBatchSize: 1,
      languageTracks: draft.languageTracks.map(track => ({ ...track, episodeBatchSize: 1 })) });
    await syncOneSeriesFromLiveChart(store, saved, { now: beforeRelease, overwriteSchedule: true,
      fetchEpisodes: (link, options) => fetchLiveChartEpisodes(link, { ...options, fetchHtml }) });
    const synced = store.getSeries(saved.id);
    assert.equal(synced.episodeBatchSize, 120);
    assert.equal(synced.languageTracks.find(track => track.code === 'de').episodeBatchSize, 120);
  });
}

for (const dub of [false, true]) {
  test(`LiveChart combines overlapping and adjacent ${dub ? 'dub' : 'original'} ranges but stops at a gap`, () => {
    const html = ['EP1-50', 'EP40-80', 'EP81-120', 'EP50-70'].map((label, index) =>
      row(label, { dub, id: String(index + 1) })).join('');
    const release = (result) => dub ? result.languageTracks.find(track => track.code === 'de') : result;
    assert.equal(release(parse(html)).nextEpisode, 1);
    assert.equal(release(parse(html)).episodeBatchSize, 120);
    const withGap = ['EP1-50', 'EP40-80', 'EP82-120'].map((label, index) =>
      row(label, { dub, id: String(index + 1) })).join('');
    assert.equal(release(parse(withGap)).episodeBatchSize, 80);
    const differentDate = row('EP1-80', { dub }) +
      row('EP81-120', { dub, id: '2', stamp: now.plus({ days: 7 }) });
    assert.equal(release(parse(differentDate)).episodeBatchSize, 80);
  });
}

test('original and dub storage and LiveChart use the same 10000-episode ceiling', async (t) => {
  const { store } = await setup(t);
  assert.equal(MAX_EPISODE_BATCH_SIZE, 10000);
  for (const count of [MAX_EPISODE_BATCH_SIZE, MAX_EPISODE_BATCH_SIZE + 1]) {
    await store.upsertSeries({ ...series, episodeCount: null, episodeBatchSize: count,
      languageTracks: [{ ...germanTrack, episodeBatchSize: count }] });
    const saved = store.getSeries(series.id);
    assert.equal(saved.episodeBatchSize, MAX_EPISODE_BATCH_SIZE);
    assert.equal(saved.languageTracks.find(track => track.code === 'de').episodeBatchSize, MAX_EPISODE_BATCH_SIZE);
    const parsed = parse(row(`EP1-${count}`) + row(`All${count}EPs`, { dub: true, id: '2' }));
    assert.equal(parsed.episodeBatchSize, MAX_EPISODE_BATCH_SIZE);
    assert.equal(parsed.languageTracks.find(track => track.code === 'de').episodeBatchSize, MAX_EPISODE_BATCH_SIZE);
  }
});

test('the editor accepts 120 episodes for original and German releases and exposes the shared limit', async (t) => {
  const { store } = await setup(t);
  const saved = await store.upsertSeries({ ...series, episodeBatchSize: 1,
    languageTracks: [{ ...germanTrack, episodeBatchSize: 1 }] });
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = createWebApp(store, { enabled: false, async post() { assert.fail('Editing must not post'); } }, root);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/series/${saved.id}`;
  const headers = process.env.WEB_PASSWORD
    ? { Authorization: `Basic ${Buffer.from(`${process.env.WEB_USER || 'admin'}:${process.env.WEB_PASSWORD}`).toString('base64')}` }
    : {};
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  const $ = load(await response.text());
  for (const name of ['episodeBatchSize', 'languageBatchSize_de']) {
    assert.equal($(`input[name="${name}"]`).attr('max'), String(MAX_EPISODE_BATCH_SIZE));
  }
  const body = new URLSearchParams();
  $('#series-form input, #series-form select, #series-form textarea').each((_, element) => {
    const input = $(element), name = input.attr('name');
    if (!name || (input.attr('type') === 'checkbox' && !input.is(':checked'))) return;
    body.append(name, input.attr('type') === 'checkbox' ? 'on' : input.val() || '');
  });
  body.set('episodeBatchSize', '120');
  body.set('languageBatchSize_de', '120');
  assert.equal((await fetch(url, { method: 'POST', redirect: 'manual', headers, body })).status, 302);
  const edited = store.getSeries(saved.id);
  assert.equal(edited.episodeBatchSize, 120);
  assert.equal(edited.languageTracks.find(track => track.code === 'de').episodeBatchSize, 120);
  assert.equal(store.snapshot().posts.length, 0);
});
