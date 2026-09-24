import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { load } from 'cheerio';
import { createStore } from '../src/store.js';
import { automaticPostsEnabled, automaticPostsLocked } from '../src/discordPosting.js';
import { checkDueAnnouncements, checkCompletionAnnouncements, startScheduler } from '../src/scheduler.js';
import { shouldRunDailyLiveChartSync } from '../src/livechartSync.js';
import { shouldRunDiscovery } from '../src/livechartDiscovery.js';
import { createWebApp } from '../src/web.js';

const now = DateTime.fromISO('2026-09-24T18:00:00', { zone: 'Europe/Berlin' });
const release = { id: 'release', title: 'Release', enabled: true, status: 'airing', service: 'Crunchyroll',
  nextEpisode: 5, episodeCount: 12, nextDate: now.toISODate(), releaseTime: '18:00', weekly: true };
const finished = { id: 'finished', title: 'Finished', enabled: false, status: 'finished', service: 'Crunchyroll',
  nextEpisode: null, episodeCount: 12, finishedAt: now.minus({ days: 8 }).toISO() };

function environment(t, value) {
  const original = process.env.DISCORD_AUTO_POSTS;
  t.after(() => {
    if (original === undefined) delete process.env.DISCORD_AUTO_POSTS;
    else process.env.DISCORD_AUTO_POSTS = original;
  });
  if (value === undefined) delete process.env.DISCORD_AUTO_POSTS;
  else process.env.DISCORD_AUTO_POSTS = value;
}

async function setup(t, enabled = false) {
  environment(t, undefined);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-auto-posting-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'db.json'));
  await store.init();
  await store.updateSettings({ ...store.getSettings(), automaticDiscordPostsEnabled: enabled });
  await store.upsertSeries(release);
  await store.upsertSeries(finished);
  const messages = [];
  const discord = { enabled: true, ready: true, listTextChannels: async () => [], listMentionRoles: async () => [],
    post: async (message) => { messages.push(message); return { sent: [{ channelId: '111111111111111111' }], failed: [] }; } };
  return { store, discord, messages };
}

test('automatic-post setting persists, while older databases retain production behavior', async (t) => {
  const { store } = await setup(t);
  await store.updateSettings({ ...store.getSettings(), automaticDiscordPostsEnabled: 'false' });
  await store.updateSettings({ timeZone: 'Europe/Berlin' });
  const reloaded = createStore(store.filePath);
  await reloaded.init();
  assert.equal(reloaded.getSettings().automaticDiscordPostsEnabled, false);
  await reloaded.replaceData({ settings: {} });
  assert.equal(reloaded.getSettings().automaticDiscordPostsEnabled, true);
  assert.equal(automaticPostsEnabled(reloaded.getSettings()), true);
});

test('disabled automatic posts suppress originals, dubs and completions without altering delivery state', async (t) => {
  const { store, discord, messages } = await setup(t);
  await store.upsertSeries({ ...release, scheduleLink: 'https://www.livechart.me/anime/123/schedules',
    languageTracks: [{ code: 'de', enabled: true, available: true, nextEpisode: 2, nextDate: now.toISODate(), releaseTime: '18:00' }] });
  const before = store.snapshot();
  const syncSeries = () => { throw new Error('Disabled posting must not request a pre-post sync'); };
  assert.equal((await checkDueAnnouncements(store, discord, { now, syncSeries })).reason, 'automatic_posts_disabled');
  assert.equal((await checkCompletionAnnouncements(store, discord, { now })).reason, 'automatic_posts_disabled');
  assert.equal(messages.length, 0);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(shouldRunDailyLiveChartSync(store.getSettings(), now), true);
  assert.equal(shouldRunDiscovery(store.getSettings(), store.getDiscovery(), now), true);
});

test('server-level lock suppresses automatic posts even after a production backup restore', async (t) => {
  const { store, discord, messages } = await setup(t, true);
  process.env.DISCORD_AUTO_POSTS = 'false';
  const production = store.snapshot();
  await store.replaceData(production);
  assert.equal(store.getSettings().automaticDiscordPostsEnabled, true);
  assert.equal(automaticPostsLocked(), true);
  assert.equal(automaticPostsEnabled(store.getSettings()), false);
  assert.equal((await checkDueAnnouncements(store, discord, { now })).reason, 'automatic_posts_disabled');
  assert.equal((await checkCompletionAnnouncements(store, discord, { now })).reason, 'automatic_posts_disabled');
  assert.equal(messages.length, 0);
  process.env.DISCORD_AUTO_POSTS = 'true';
  assert.equal(automaticPostsEnabled(store.getSettings()), true);
  await store.updateSettings({ ...store.getSettings(), automaticDiscordPostsEnabled: false });
  assert.equal(automaticPostsEnabled(store.getSettings()), false);
});

test('re-enabling automatic posts preserves normal delivery and duplicate prevention', async (t) => {
  const { store, discord, messages } = await setup(t);
  await store.updateSettings({ ...store.getSettings(), automaticDiscordPostsEnabled: true });
  assert.equal((await checkDueAnnouncements(store, discord, { now })).posted, 1);
  assert.equal((await checkCompletionAnnouncements(store, discord, { now })).posted, 1);
  assert.equal((await checkDueAnnouncements(store, discord, { now })).posted, 0);
  assert.equal((await checkCompletionAnnouncements(store, discord, { now })).posted, 0);
  assert.equal(messages.length, 2);
});

test('turning automatic posts off during a pre-post sync stops the pending announcement', async (t) => {
  const { store, discord, messages } = await setup(t, true);
  await store.upsertSeries({ ...release, scheduleLink: 'https://www.livechart.me/anime/123/schedules' });
  let synced = 0;
  const syncSeries = async () => {
    synced += 1;
    await store.updateSettings({ ...store.getSettings(), automaticDiscordPostsEnabled: false });
    return { changed: false, updated: store.getSeries('release') };
  };
  assert.equal((await checkDueAnnouncements(store, discord, { now, syncSeries })).reason, 'automatic_posts_disabled');
  assert.equal(synced, 1);
  assert.equal(messages.length, 0);
  assert.equal(store.getSeries('release').nextEpisode, 5);
  assert.equal(store.getSeries('release').lastPostedKey, '');
});

test('turning automatic posts off between completion sends stops remaining entries', async (t) => {
  const { store, discord, messages } = await setup(t, true);
  await store.upsertSeries({ ...finished, id: 'second-finished', title: 'Second finished' });
  const post = discord.post;
  discord.post = async (...args) => {
    await store.updateSettings({ ...store.getSettings(), automaticDiscordPostsEnabled: false });
    return post(...args);
  };
  const result = await checkCompletionAnnouncements(store, discord, { now });
  assert.equal(result.posted, 1);
  assert.equal(result.reason, 'automatic_posts_disabled');
  assert.equal(messages.length, 1);
  assert.equal(store.listSeries().filter((series) => series.completionNotifiedAt).length, 1);
});

test('startup and subsequent scheduler ticks remain silent with a connected Discord bot', async (t) => {
  const { store, discord, messages } = await setup(t);
  const before = store.snapshot();
  let tick;
  t.mock.method(globalThis, 'setInterval', (callback) => { tick = callback; return 'fake-timer'; });
  startScheduler(store, discord);
  await new Promise(setImmediate);
  await tick();
  assert.equal(messages.length, 0);
  assert.deepEqual(store.snapshot(), before);
});

test('Settings supports toggling automatic posts and shows the server lock; manual test posts still work', async (t) => {
  const { store, discord, messages } = await setup(t);
  const app = createWebApp(store, discord, process.cwd());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', redirect: 'manual', body: new URLSearchParams(body) });
  await post('/settings', { automaticDiscordPostsEnabled: 'on' });
  assert.equal(store.getSettings().automaticDiscordPostsEnabled, true);
  await post('/settings', {});
  assert.equal(store.getSettings().automaticDiscordPostsEnabled, false);
  process.env.DISCORD_AUTO_POSTS = 'false';
  const $ = load(await (await fetch(`${base}/settings`)).text());
  assert.equal($('input[name="automaticDiscordPostsEnabled"]').is(':checked'), false);
  assert.equal($('input[name="automaticDiscordPostsEnabled"]').is(':disabled'), true);
  assert.match($.text(), /DISCORD_AUTO_POSTS=false/);
  const response = await post('/series/release/test-post', { title: release.title, service: 'Crunchyroll', enabled: 'on', weekly: 'on',
    status: 'airing', nextEpisode: '5', episodeCount: '12', nextDate: DateTime.now().toISODate(), releaseTime: '18:00' });
  assert.equal(new URL(response.headers.get('location'), base).searchParams.get('ok'), 'Test post sent');
  assert.equal(messages.length, 1);
  assert.equal(store.getSeries('release').lastPostedKey, '');
  assert.equal(store.snapshot().posts[0].type, 'manual-test');
});
