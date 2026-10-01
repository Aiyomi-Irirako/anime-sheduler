import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { createStore } from '../src/store.js';
import { parseLiveChartEpisodes } from '../src/livechart.js';
import { syncOneSeriesFromLiveChart } from '../src/livechartSync.js';
import { checkDueAnnouncements } from '../src/scheduler.js';
import { getNextLanguageRelease, isSeriesComplete } from '../src/schedule.js';

const date = value => DateTime.fromISO(value, { zone: 'Europe/Berlin' });
const checkedAt = date('2026-10-01T10:00:00');
const finishedMain = `<article data-release-schedule-release-schedule-id="1">
  <a href="/anime/13115/schedules/1">Released</a>
  <a title="Simulcast: Subbed">Simulcast: Subbed</a>
  <span><svg><use href="#icon:subtitles"></use></svg></span>
  <span data-tracklist-json="{&quot;de&quot;:[&quot;DE&quot;]}"></span>
  <span class="lc-text-contextual-accent">Crunchyroll</span></article>`;

function dubRow({ episode = 14, at = null, code = 'de', released = false } = {}) {
  const label = episode === null ? 'Upcoming' : `EP${episode}`;
  return `<article data-release-schedule-release-schedule-id="2">
    <a href="/anime/13115/schedules/2"><time data-label="${label}"${at ? ` data-timestamp="${at.toSeconds()}"` : ''}>${label}</time>
    ${released ? 'Released' : 'This release requires confirmation.'}</a>
    <a title="Simulcast: Dubbed">Simulcast: Dubbed</a>
    <span><svg><use href="#icon:audio"></use></svg></span>
    <span data-tracklist-json="{&quot;${code}&quot;:[&quot;DE&quot;]}"></span>
    <span class="lc-text-contextual-accent">Crunchyroll</span></article>`;
}

async function setup(t, { id = 'rezero', title = 'Re:ZERO Season 4', episodeCount = 19,
  nextEpisode = 17, postedEpisode = 16, time = '16:00' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-paused-dub-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('anime-paused-dub-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = createStore(path.join(directory, 'db.json'));
  await store.init();
  await store.updateSettings({ ...store.getSettings(), timeZone: 'Europe/Berlin',
    reminderMinutes: 0, automaticDiscordPostsEnabled: true,
    preferredScheduleLanguage: 'de', enabledLanguageCodes: ['de'] });
  const lastPostedAt = date(`2026-09-30T${time}:30`).toISO();
  const lastPostedKey = `${id}:language:de:${postedEpisode}:release-time:${date(`2026-09-30T${time}:00`).toISO()}`;
  await store.upsertSeries({ id, title, service: 'Crunchyroll',
    scheduleLink: 'https://www.livechart.me/anime/13115/schedules',
    scheduleMode: 'livechart', liveChartLanguageStrict: false, enabled: true,
    status: 'finished', nextEpisode: null, nextDate: '', releaseDay: '', releaseTime: '',
    episodeCount, languageTracks: [{ code: 'de', enabled: true, available: true,
      nextEpisode, nextDate: '2026-10-07', releaseDay: 'wednesday', releaseTime: time,
      weekly: true, lastPostedKey, lastPostedAt, source: 'Simulcast: Dubbed' }] });
  const messages = [];
  const discord = { enabled: true, ready: true,
    async post(message) { messages.push(message.embeds[0].toJSON()); } };
  const getSeries = () => store.getSeries(id);
  const getTrack = () => getSeries().languageTracks.find(track => track.code === 'de');
  const sync = html => (targetStore, series, options) => syncOneSeriesFromLiveChart(targetStore, series, {
    ...options, fetchEpisodes: async (_, parseOptions) => parseLiveChartEpisodes(html, parseOptions)
  });
  return { store, discord, messages, id, getSeries, getTrack, sync, lastPostedKey, lastPostedAt };
}

function assertPaused(context, expectedEpisode) {
  const track = context.getTrack();
  assert.equal(track.nextEpisode, expectedEpisode);
  assert.equal(track.nextDate, '');
  assert.equal(track.releaseTime, '');
  assert.equal(track.releaseDay, '');
  assert.equal(track.lastPostedKey, context.lastPostedKey);
  assert.equal(track.lastPostedAt, context.lastPostedAt);
  assert.equal(getNextLanguageRelease(context.getSeries(), track, context.store.getSettings(), checkedAt), null);
  assert.equal(isSeriesComplete(context.getSeries()), false);
}

test('a later dated Re:ZERO dub corrects inflated progress without erasing its post history', async t => {
  const context = await setup(t);
  const html = finishedMain + dubRow({ episode: 14, at: date('2026-10-14T16:00:00') });
  await context.sync(html)(context.store, context.getSeries(), { now: checkedAt, overwriteSchedule: true });
  const track = context.getTrack();
  assert.equal(track.nextEpisode, 14);
  assert.equal(track.nextDate, '2026-10-14');
  assert.equal(track.releaseTime, '16:00');
  assert.equal(track.lastPostedKey, context.lastPostedKey);
  assert.equal(track.lastPostedAt, context.lastPostedAt);
  assert.equal(context.messages.length, 0);
});

test('an expired Hana-Kimi dub corrects its episode and clears the invented weekly release', async t => {
  const context = await setup(t, { id: 'hana-kimi', title: 'Hana-Kimi Season 2',
    episodeCount: 13, nextEpisode: 13, postedEpisode: 12, time: '18:00' });
  const html = finishedMain + dubRow({ episode: 10, at: date('2026-09-16T18:00:00') });
  await context.sync(html)(context.store, context.getSeries(), { now: checkedAt, overwriteSchedule: true });
  assertPaused(context, 10);
});

for (const example of [
  { name: 'Re:ZERO', html: finishedMain + dubRow({ episode: 14, at: date('2026-10-14T16:00:00') }),
    at: date('2026-10-07T16:00:30'), options: {} },
  { name: 'Hana-Kimi', html: finishedMain + dubRow({ episode: 10, at: date('2026-09-16T18:00:00') }),
    at: date('2026-10-07T18:00:30'), options: { id: 'hana-kimi', title: 'Hana-Kimi Season 2',
      episodeCount: 13, nextEpisode: 13, postedEpisode: 12, time: '18:00' } }
]) {
  test(`pre-post sync stops the invented 7 October ${example.name} dub announcement`, async t => {
    const context = await setup(t, example.options);
    const result = await checkDueAnnouncements(context.store, context.discord, {
      now: example.at, syncSeries: context.sync(example.html)
    });
    assert.equal(result.posted, 0);
    assert.equal(context.messages.length, 0);
    assert.equal(context.getTrack().lastPostedKey, context.lastPostedKey);
    assert.equal(context.store.snapshot().posts.length, 0);
  });
}

for (const episode of [14, null]) {
  test(`an undated legacy dub ${episode === null ? 'with an unknown episode' : 'behind the saved post number'} pauses weekly posting`, async t => {
    const context = await setup(t);
    const html = finishedMain + dubRow({ episode });
    const result = await checkDueAnnouncements(context.store, context.discord, {
      now: date('2026-10-07T16:00:30'), syncSeries: context.sync(html)
    });
    assert.equal(result.posted, 0);
    assert.equal(context.messages.length, 0);
    assertPaused(context, episode ?? 17);
  });
}

for (const source of [
  { name: 'missing', html: finishedMain + dubRow({ code: 'fr', episode: 17, at: date('2026-10-07T16:00:00') }), expectedEpisode: 17 },
  { name: 'expired', html: finishedMain + dubRow({ episode: 16, at: date('2026-09-30T16:00:00') }), expectedEpisode: 17 },
  { name: 'already posted', html: finishedMain + dubRow({ episode: 16, at: date('2026-09-30T16:00:00') }), expectedEpisode: 17 }
]) {
  test(`the ${source.name} German source date cannot retain the extrapolated weekly date`, async t => {
    const context = await setup(t);
    const now = source.name === 'already posted' ? date('2026-09-30T16:01:00') : checkedAt;
    await context.sync(source.html)(context.store, context.getSeries(), { now, overwriteSchedule: true });
    assertPaused(context, source.expectedEpisode);
    const result = await checkDueAnnouncements(context.store, context.discord, {
      now: date('2026-10-07T16:00:30'), syncSeries: context.sync(source.html)
    });
    assert.equal(result.posted, 0);
    assert.equal(context.messages.length, 0);
  });
}

test('a paused dub resumes at its corrected lower episode on the newly announced date only once', async t => {
  const context = await setup(t);
  const pausedHtml = finishedMain + dubRow({ episode: 14 });
  await context.sync(pausedHtml)(context.store, context.getSeries(), { now: checkedAt, overwriteSchedule: true });
  assertPaused(context, 14);
  const releaseAt = date('2026-10-14T16:00:00');
  const resumedHtml = finishedMain + dubRow({ episode: 14, at: releaseAt });
  await context.sync(resumedHtml)(context.store, context.getSeries(), { now: checkedAt.plus({ days: 1 }), overwriteSchedule: true });
  assert.equal(context.getTrack().nextDate, '2026-10-14');
  assert.equal((await checkDueAnnouncements(context.store, context.discord, {
    now: releaseAt.plus({ seconds: 30 }), syncSeries: context.sync(resumedHtml)
  })).posted, 1);
  assert.equal(context.store.snapshot().posts[0].episode, 14);
  assert.match(context.messages[0].title, /Episode 14/);
  await context.sync(resumedHtml)(context.store, context.getSeries(), {
    now: releaseAt.plus({ minutes: 1 }), overwriteSchedule: true
  });
  assert.equal(context.getTrack().nextDate, '');
  assert.equal(context.getTrack().releaseDay, '');
  assert.equal((await checkDueAnnouncements(context.store, context.discord, {
    now: releaseAt.plus({ minutes: 1 }), syncSeries: context.sync(resumedHtml)
  })).posted, 0);
  assert.equal(context.messages.length, 1);
});
