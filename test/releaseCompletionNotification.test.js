import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { createStore } from '../src/store.js';
import { createDiscordService } from '../src/discordBot.js';
import { checkReleaseCompletionAnnouncements } from '../src/scheduler.js';

const now = DateTime.fromISO('2026-10-31T17:46:00', { zone: 'Europe/Berlin' });
const id = 'released-german-version';
const channelA = '111111111111111111';
const channelB = '222222222222222222';
const notice = { languageCode: 'de', episodeStart: 15, episodeEnd: 19, previousEpisode: 14,
  detectedAt: now.toISO(), notifiedAt: '', sentChannelIds: [] };
const completed = {
  id, title: 'Completed original and German dub', status: 'finished', enabled: false,
  nextEpisode: null, episodeCount: 19, nextDate: '', releaseDay: '', releaseTime: '',
  service: 'Crunchyroll', streamingServiceId: 'KEEP-SERVICE-ID', tvdbId: '123456', note: 'Keep this note',
  finishedAt: now.toISO(), lastPostedKey: `${id}:main:19:release-time:2026-09-30T16:00:00.000+02:00`,
  lastPostedAt: '2026-09-30T16:00:30+02:00',
  languageTracks: [{ code: 'de', enabled: false, available: true, nextEpisode: null,
    nextDate: '', releaseDay: '', releaseTime: '',
    lastPostedKey: `${id}:language:de:14:release-time:2026-10-14T16:00:00.000+02:00`,
    lastPostedAt: '2026-10-14T16:00:30+02:00' }],
  releaseCompletionNotices: [notice]
};

async function setup(t, overrides = {}) {
  const previousEnvironment = process.env.DISCORD_AUTO_POSTS;
  delete process.env.DISCORD_AUTO_POSTS;
  t.after(() => {
    if (previousEnvironment === undefined) delete process.env.DISCORD_AUTO_POSTS;
    else process.env.DISCORD_AUTO_POSTS = previousEnvironment;
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-release-completion-post-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'isolated-db.json'));
  await store.init();
  await store.replaceData({ ...store.snapshot(), settings: { ...store.getSettings(), timeZone: 'Europe/Berlin',
    automaticDiscordPostsEnabled: true, enabledLanguageCodes: ['de'], discordChannelIds: [channelA, channelB] },
  series: [{ ...completed, ...overrides }] });
  const discord = createDiscordService(store);
  discord.enabled = true;
  discord.ready = true;
  const sent = [];
  t.mock.method(discord, 'sendToChannel', async (channelId, message) => {
    sent.push({ channelId, message });
    return { id: `fake-${sent.length}` };
  });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  return { store, discord, sent, filePath: store.filePath };
}

function regularState(series) {
  const { releaseCompletionNotices, updatedAt, ...rest } = series;
  return rest;
}

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

test('a finished disabled series sends one truthful language completion catch-up without changing episode history', async (t) => {
  const { store, discord, sent } = await setup(t);
  const before = regularState(store.getSeries(id));
  assert.deepEqual(await checkReleaseCompletionAnnouncements(store, discord, { now }), { posted: 1, failed: 0 });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(item => item.channelId), [channelA, channelB]);
  const message = sent[0].message;
  const text = JSON.stringify(message.embeds[0].toJSON());
  assert.match(text, /German/);
  assert.match(text, /15(?:-|–| to )19/);
  assert.deepEqual(message.allowedMentions, { parse: [] });
  assert.deepEqual(regularState(store.getSeries(id)), before);
  const receipt = store.getSeries(id).releaseCompletionNotices[0];
  assert.ok(receipt.notifiedAt);
  assert.deepEqual(receipt.sentChannelIds, [channelA, channelB]);
  assert.deepEqual(await checkReleaseCompletionAnnouncements(store, discord, { now: now.plus({ minutes: 1 }) }), { posted: 0, failed: 0 });
});

test('completion catch-up receipts survive restart and backup restore without another post', async (t) => {
  const { store, discord, sent, filePath } = await setup(t);
  await checkReleaseCompletionAnnouncements(store, discord, { now });
  const reloaded = createStore(filePath);
  await reloaded.init();
  await reloaded.replaceData(store.snapshot());
  assert.deepEqual(await checkReleaseCompletionAnnouncements(reloaded, discord, { now: now.plus({ days: 1 }) }), { posted: 0, failed: 0 });
  assert.equal(sent.length, 2);
});

test('partial completion delivery retries only the failed channel after restart', async (t) => {
  const { store, discord, sent, filePath } = await setup(t);
  t.mock.method(console, 'warn', () => {});
  const original = discord.sendToChannel;
  const attempts = [];
  discord.sendToChannel = async (channelId, message) => {
    attempts.push(channelId);
    if (channelId === channelB) throw new Error('Missing permission');
    return original(channelId, message);
  };
  assert.deepEqual(await checkReleaseCompletionAnnouncements(store, discord, { now }), { posted: 1, failed: 1 });
  assert.equal(store.getSeries(id).releaseCompletionNotices[0].notifiedAt, '');
  assert.deepEqual(store.getSeries(id).releaseCompletionNotices[0].sentChannelIds, [channelA]);
  const reloaded = createStore(filePath);
  await reloaded.init();
  discord.sendToChannel = async (channelId, message) => {
    attempts.push(channelId);
    return original(channelId, message);
  };
  assert.deepEqual(await checkReleaseCompletionAnnouncements(reloaded, discord, { now: now.plus({ minutes: 1 }) }), { posted: 1, failed: 0 });
  assert.deepEqual(attempts, [channelA, channelB, channelB]);
  assert.deepEqual(sent.map(item => item.channelId), [channelA, channelB]);
  assert.ok(reloaded.getSeries(id).releaseCompletionNotices[0].notifiedAt);
});

test('an unknown completed episode range is not presented as a guessed missing batch', async (t) => {
  const { store, discord, sent } = await setup(t, { episodeCount: null,
    releaseCompletionNotices: [{ ...notice, episodeStart: null, episodeEnd: null, previousEpisode: null }] });
  assert.equal((await checkReleaseCompletionAnnouncements(store, discord, { now })).posted, 1);
  const text = JSON.stringify(sent[0].message.embeds[0].toJSON());
  assert.doesNotMatch(text, /15(?:-|–| to )19/);
  assert.doesNotMatch(text, /Episode 01/);
  assert.equal(store.getSeries(id).episodeCount, null);
});

for (const [start, end, postedRange] of [[19, 19, '19'], [15, 19, '15-19']]) {
  test(`a queued ${start}-${end} completion is skipped after its entire range gets a normal post`, async (t) => {
    const { store, discord, sent } = await setup(t, {
      languageTracks: [{ ...completed.languageTracks[0], lastPostedKey: `${id}:language:de:${postedRange}:release-time:later`,
        lastPostedAt: now.toISO() }],
      releaseCompletionNotices: [{ ...notice, episodeStart: start, episodeEnd: end }]
    });
    assert.deepEqual(await checkReleaseCompletionAnnouncements(store, discord, { now }), { posted: 0, failed: 0 });
    assert.equal(sent.length, 0);
  });
}

test('a normal finale does not hide earlier missing episodes in a queued completion range', async (t) => {
  const { store, discord, sent } = await setup(t, {
    languageTracks: [{ ...completed.languageTracks[0], lastPostedKey: `${id}:language:de:19:release-time:later`,
      lastPostedAt: now.toISO() }]
  });
  assert.equal((await checkReleaseCompletionAnnouncements(store, discord, { now })).posted, 1);
  assert.equal(sent.length, 2);
});

test('a later normal batch does not cancel an already partially delivered completion catch-up', async (t) => {
  const { store, discord, sent } = await setup(t, {
    languageTracks: [{ ...completed.languageTracks[0], lastPostedKey: `${id}:language:de:15-19:release-time:later`,
      lastPostedAt: now.toISO() }],
    releaseCompletionNotices: [{ ...notice, sentChannelIds: [channelA] }]
  });
  assert.deepEqual(await checkReleaseCompletionAnnouncements(store, discord, { now }), { posted: 1, failed: 0 });
  assert.deepEqual(sent.map(item => item.channelId), [channelB]);
});

for (const mode of ['environment', 'settings', 'offline']) {
  test(`completion catch-up respects the ${mode} posting guard without changing saved receipts`, async (t) => {
    const { store, discord, sent } = await setup(t);
    if (mode === 'environment') process.env.DISCORD_AUTO_POSTS = 'false';
    if (mode === 'settings') await store.updateSettings({ ...store.getSettings(), automaticDiscordPostsEnabled: false });
    if (mode === 'offline') discord.ready = false;
    const before = structuredClone(store.getSeries(id));
    const result = await checkReleaseCompletionAnnouncements(store, discord, { now });
    assert.equal(result.posted, 0);
    assert.equal(sent.length, 0);
    assert.deepEqual(store.getSeries(id), before);
  });
}

test('a reopened language and a disabled ongoing series are not eligible for a stale completion post', async (t) => {
  for (const enabled of [true, false]) {
    const { store, discord, sent } = await setup(t, { enabled, status: 'airing', nextEpisode: 20,
      languageTracks: [{ ...completed.languageTracks[0], enabled: true, nextEpisode: 20 }] });
    assert.equal((await checkReleaseCompletionAnnouncements(store, discord, { now })).posted, 0);
    assert.equal(sent.length, 0);
  }
});

test('a future confirmation time cannot dispatch a completion catch-up early', async (t) => {
  const { store, discord, sent } = await setup(t, {
    releaseCompletionNotices: [{ ...notice, detectedAt: now.plus({ minutes: 1 }).toISO() }] });
  assert.equal((await checkReleaseCompletionAnnouncements(store, discord, { now })).posted, 0);
  assert.equal(sent.length, 0);
});

test('a manually handled completion does not send its remaining catch-up notice', async (t) => {
  const { store, discord, sent } = await setup(t, { completionAcknowledged: true });
  const before = structuredClone(store.getSeries(id));
  assert.deepEqual(await checkReleaseCompletionAnnouncements(store, discord, { now }), { posted: 0, failed: 0 });
  assert.equal(sent.length, 0);
  assert.deepEqual(store.getSeries(id), before);
});

test('metadata and manual acknowledgement changes during a send are preserved', async (t) => {
  const { store, discord } = await setup(t);
  const started = deferred();
  const released = deferred();
  const original = discord.post.bind(discord);
  t.mock.method(discord, 'post', async (...args) => {
    started.resolve();
    await released.promise;
    return original(...args);
  });
  const pending = checkReleaseCompletionAnnouncements(store, discord, { now });
  await started.promise;
  await store.upsertSeries({ ...store.getSeries(id), note: 'Changed during delivery', tvdbId: '987654', completionAcknowledged: true });
  released.resolve();
  await pending;
  const saved = store.getSeries(id);
  assert.equal(saved.note, 'Changed during delivery');
  assert.equal(saved.tvdbId, '987654');
  assert.equal(saved.completionAcknowledged, true);
});

test('a deleted series is not recreated when completion delivery finishes', async (t) => {
  const { store, discord } = await setup(t);
  const started = deferred();
  const released = deferred();
  const original = discord.post.bind(discord);
  t.mock.method(discord, 'post', async (...args) => {
    started.resolve();
    await released.promise;
    return original(...args);
  });
  const pending = checkReleaseCompletionAnnouncements(store, discord, { now });
  await started.promise;
  await store.deleteSeries(id);
  released.resolve();
  await pending;
  assert.equal(store.getSeries(id), null);
});
