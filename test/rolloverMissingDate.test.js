import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { parseLiveChartEpisodes } from '../src/livechart.js';
import { syncOneSeriesFromLiveChart } from '../src/livechartSync.js';
import { checkDueAnnouncements } from '../src/scheduler.js';

const releaseAt = DateTime.fromISO('2026-09-27T23:00:00', { zone: 'Europe/Berlin' });
const now = releaseAt.plus({ seconds: 57 });
const id = 'one-piece';

function scheduleHtml({ kind = 'main', episode = 1181, date = null, language = 'de' } = {}) {
  const dub = kind === 'language';
  const label = episode === null ? 'Upcoming' : `EP${episode}`;
  return `<article data-release-schedule-release-schedule-id="1">
    <a href="/anime/321/schedules/1"><time data-label="${label}"${date ? ` data-timestamp="${date.toSeconds()}"` : ''}>${label}</time></a>
    <a title="Simulcast: ${dub ? 'Dubbed' : 'Subbed'}">Simulcast</a>
    <span><svg><use href="#icon:${dub ? 'audio' : 'subtitles'}"></use></svg></span>
    <span data-tracklist-json="{&quot;${language}&quot;:[&quot;DE&quot;]}"></span>
    <span class="lc-text-contextual-accent">Crunchyroll</span></article>`;
}

function setup(kind = 'main', afterSync = null) {
  const settings = { timeZone: 'Europe/Berlin', reminderMinutes: 0,
    preferredScheduleLanguage: 'de', enabledLanguageCodes: ['de'] };
  const pending = { nextEpisode: 1180, nextDate: '2026-09-27', releaseDay: 'sunday',
    releaseTime: '23:00', episodeBatchSize: 1, weekly: true, lastPostedKey: '', lastPostedAt: '' };
  let current = { id, title: 'One Piece', service: 'Crunchyroll',
    scheduleLink: 'https://www.livechart.me/anime/321/schedules', liveChartLanguageStrict: true,
    enabled: true, status: kind === 'main' ? 'airing' : 'finished', episodeCount: null,
    nextEpisode: null, nextDate: '', releaseDay: '', releaseTime: '', lastPostedKey: '', lastPostedAt: '',
    languageTracks: [], ...(kind === 'main' ? pending : {
      languageTracks: [{ code: 'de', enabled: true, available: true, ...pending }]
    }) };
  const messages = [], posts = [];
  let fetchCalls = 0;
  const store = {
    getSettings: () => structuredClone(settings),
    snapshot: () => ({ settings: structuredClone(settings), series: [structuredClone(current)] }),
    getSeries: (seriesId) => seriesId === id ? structuredClone(current) : null,
    async upsertSeries(next) { current = structuredClone(next); return structuredClone(current); },
    async replaceSeries(seriesId, next) {
      assert.equal(seriesId, id);
      current = structuredClone(next);
      return structuredClone(current);
    },
    async addPostLog(entry) { posts.push(entry); }
  };
  const discord = { enabled: true, ready: true,
    async post(message) { messages.push(message.embeds[0].toJSON()); } };
  const run = (html, at = now) => checkDueAnnouncements(store, discord, { now: at,
    syncSeries: async (targetStore, series, options) => {
      const result = await syncOneSeriesFromLiveChart(targetStore, series, {
        ...options, fetchEpisodes: async (_, parseOptions) => {
          fetchCalls += 1;
          return parseLiveChartEpisodes(html, parseOptions);
        }
      });
      if (afterSync) {
        result.updated = await store.replaceSeries(id, afterSync(store.getSeries(id)));
      }
      return result;
    } });
  return { store, messages, posts, run, fetchCalls: () => fetchCalls };
}

for (const kind of ['main', 'language']) {
  test(`posts the due ${kind} episode once when LiveChart advances to an undated episode`, async () => {
    const { store, messages, posts, run } = setup(kind);
    const html = scheduleHtml({ kind });
    assert.equal((await run(html)).posted, 1);
    assert.equal(posts[0].episode, 1180);
    assert.equal(posts[0].releaseAt, releaseAt.toISO());
    assert.equal(posts[0].type, kind === 'main' ? 'auto' : 'auto-language');
    const field = messages[0].fields.find(item => item.name.startsWith('Episode'));
    assert.equal(field.value, kind === 'main' ? 'Episode 1180' : 'Episode 1180 (German)');

    const saved = store.getSeries(id);
    const target = kind === 'main' ? saved : saved.languageTracks.find(track => track.code === 'de');
    assert.equal(target.nextEpisode, 1181);
    assert.equal(target.nextDate, '');
    assert.equal(target.releaseTime, '');
    assert.equal(target.releaseDay, '');
    const releaseKind = kind === 'main' ? 'main' : 'language:de';
    assert.equal(target.lastPostedKey, `${id}:${releaseKind}:1180:release-time:${releaseAt.toISO()}`);
    assert.equal(target.lastPostedAt, now.toISO());
    assert.equal((await run(html, now.plus({ minutes: 1 }))).posted, 0);
    assert.equal(messages.length, 1);
    assert.equal(posts.length, 1);
  });

  test(`does not post a ${kind} episode whose own date was withdrawn`, async () => {
    const { run, messages } = setup(kind);
    assert.equal((await run(scheduleHtml({ kind, episode: 1180 }))).posted, 0);
    assert.equal(messages.length, 0);
  });

  test(`respects a postponed date for the same ${kind} episode`, async () => {
    const { run, messages } = setup(kind);
    assert.equal((await run(scheduleHtml({ kind, episode: 1180, date: releaseAt.plus({ days: 1 }) }))).posted, 0);
    assert.equal(messages.length, 0);
  });

  test(`does not recover an expired ${kind} release when the next episode lacks a date`, async () => {
    const { run, messages, fetchCalls } = setup(kind);
    assert.equal((await run(scheduleHtml({ kind }), releaseAt.plus({ hours: 6, seconds: 1 }))).posted, 0);
    assert.equal(messages.length, 0);
    assert.equal(fetchCalls(), 0);
  });

  test(`does not preserve the ${kind} release if the series is disabled during sync`, async () => {
    const { run, messages } = setup(kind, series => ({ ...series, enabled: false }));
    assert.equal((await run(scheduleHtml({ kind }))).posted, 0);
    assert.equal(messages.length, 0);
  });
}

test('does not preserve a dub release if its track is disabled during sync', async () => {
  const { run, messages } = setup('language', series => ({ ...series,
    languageTracks: series.languageTracks.map(track => ({ ...track, enabled: false }))
  }));
  assert.equal((await run(scheduleHtml({ kind: 'language' }))).posted, 0);
  assert.equal(messages.length, 0);
});

test('does not post when the preferred subtitle schedule is unavailable', async () => {
  const { run, messages, store } = setup();
  assert.equal((await run(scheduleHtml({ language: 'fr' }))).posted, 0);
  assert.equal(messages.length, 0);
  assert.equal(store.getSeries(id).nextEpisode, null);
});

test('does not post when LiveChart replaces the main episode number with an unknown episode', async () => {
  const { run, messages, store } = setup();
  assert.equal((await run(scheduleHtml({ episode: null }))).posted, 0);
  assert.equal(messages.length, 0);
  assert.equal(store.getSeries(id).nextEpisode, null);
});
