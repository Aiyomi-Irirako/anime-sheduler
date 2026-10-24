import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { createStore } from "../src/store.js";
import { syncOneSeriesFromLiveChart } from "../src/livechartSync.js";
import { checkLateDubAnnouncements } from "../src/scheduler.js";
import { getNextLanguageRelease, isSeriesComplete } from "../src/schedule.js";

const now = DateTime.fromISO("2026-10-25T10:00:00", { zone: "Europe/Berlin" });
const releaseAt = now.minus({ days: 1 }).toISO();
const channelId = "111111111111111111";

async function setup(t, overrides = {}, settingsPatch = {}) {
  const originalLock = process.env.DISCORD_AUTO_POSTS;
  delete process.env.DISCORD_AUTO_POSTS;
  t.after(() => {
    if (originalLock === undefined) delete process.env.DISCORD_AUTO_POSTS;
    else process.env.DISCORD_AUTO_POSTS = originalLock;
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anime-late-finished-dub-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, "db.json"));
  await store.init();
  await store.replaceData({
    ...store.snapshot(),
    settings: { ...store.getSettings(), timeZone: "Europe/Berlin", enabledLanguageCodes: ["de"],
      automaticDiscordPostsEnabled: true, discordChannelIds: [channelId], ...settingsPatch },
    series: [{ id: "finished-new-dub", title: "Finished title with a newly discovered dub",
      scheduleLink: "https://www.livechart.me/anime/12345/schedules", scheduleMode: "livechart",
      service: "Crunchyroll", status: "finished", enabled: false, nextEpisode: null,
      episodeCount: 12, languageTracks: [], finishedAt: now.minus({ months: 1 }).toISO(), ...overrides }]
  });
  const messages = [];
  const discord = { enabled: true, ready: true, async post(message) {
    messages.push(message.embeds[0].toJSON());
    return { sent: [{ channelId, messageId: `fake-${messages.length}` }], failed: [] };
  } };
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request"); });
  const sync = async (sourcePatch = {}, targetStore = store) => syncOneSeriesFromLiveChart(
    targetStore, targetStore.getSeries("finished-new-dub"), { now, overwriteSchedule: true,
      async fetchEpisodes() {
        return { nextEpisode: null, episodeCount: 12, mainFinished: true, languageTracks: [],
          unscheduledLanguageTracks: [], finishedLanguageCodes: [],
          lateDubReleases: [{ languageCode: "de", episode: 1, episodeEnd: 1, releaseAt }],
          ...sourcePatch };
      }
    });
  return { store, discord, messages, sync };
}

test("a confirmed late premiere reopens a finished title without inventing the next dub date", async (t) => {
  const { store, discord, messages, sync } = await setup(t);
  await sync();
  const series = store.getSeries("finished-new-dub");
  const track = series.languageTracks.find((entry) => entry.code === "de");
  assert.equal(series.enabled, true);
  assert.equal(series.nextEpisode, null, "the original must stay finished");
  assert.equal(track.enabled, true);
  assert.equal(track.nextEpisode, 1);
  assert.equal(track.nextDate, "");
  assert.equal(track.releaseDay, "");
  assert.equal(track.releaseTime, "");
  assert.equal(getNextLanguageRelease(series, track, store.getSettings(), now), null);
  assert.equal(isSeriesComplete(series), false);
  assert.equal(series.lateDubNotices.length, 1);
  assert.equal(series.lateDubNotices[0].kind, "release");
  assert.equal(series.lateDubNotices[0].episode, 1);
  const beforeTrack = structuredClone(track);
  assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now }), { posted: 1, failed: 0 });
  assert.equal(messages.length, 1);
  assert.match(messages[0].title, /Late dub update/);
  assert.deepEqual(store.getSeries(series.id).languageTracks.find((entry) => entry.code === "de"), beforeTrack);
});

test("a finished title's late notice stays sent across repeat sync and restart", async (t) => {
  const { store, discord, messages, sync } = await setup(t);
  await sync();
  await checkLateDubAnnouncements(store, discord, { now });
  await sync();
  const reopened = createStore(store.filePath);
  await reopened.init();
  await sync({}, reopened);
  assert.equal(reopened.getSeries("finished-new-dub").lateDubNotices.length, 1);
  assert.ok(reopened.getSeries("finished-new-dub").lateDubNotices[0].notifiedAt);
  assert.deepEqual(await checkLateDubAnnouncements(reopened, discord, { now: now.plus({ minutes: 1 }) }),
    { posted: 0, failed: 0 });
  assert.equal(messages.length, 1);
});

test("a confirmed late premiere fills an enabled empty dub track on a finished title", async (t) => {
  const { store, discord, messages, sync } = await setup(t, { languageTracks: [
    { code: "de", enabled: true, available: true, nextEpisode: null, weekly: false,
      lastPostedKey: "", lastPostedAt: "", source: "legacy" }
  ] });
  await sync();
  const series = store.getSeries("finished-new-dub");
  const track = series.languageTracks.find((entry) => entry.code === "de");
  assert.equal(series.enabled, true);
  assert.equal(track.nextEpisode, 1);
  assert.equal(track.weekly, false);
  assert.equal(track.nextDate, "");
  assert.equal(track.releaseDay, "");
  assert.equal(track.releaseTime, "");
  assert.equal(series.lateDubNotices.length, 1);
  assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now }), { posted: 1, failed: 0 });
  assert.equal(messages.length, 1);
});

test("an explicitly disabled airing series is not reactivated by late premiere evidence", async (t) => {
  const { store, discord, messages, sync } = await setup(t, { status: "airing", nextEpisode: 8, enabled: false });
  await sync({ mainFinished: false, nextEpisode: 8 });
  const series = store.getSeries("finished-new-dub");
  assert.equal(series.enabled, false);
  assert.equal(series.lateDubNotices.length, 0);
  assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now }), { posted: 0, failed: 0 });
  assert.equal(messages.length, 0);
});

test("a disabled language and a previously announced dub do not reopen finished titles", async (t) => {
  for (const track of [
    { code: "de", enabled: false, available: true, nextEpisode: null },
    { code: "de", enabled: true, available: true, nextEpisode: null,
      lastPostedKey: `finished-new-dub:language:de:12:release-time:${now.minus({ months: 1 }).toISO()}`,
      lastPostedAt: now.minus({ months: 1 }).toISO() }
  ]) {
    // Existing manually disabled languages stay disabled when automatic discovery is off.
    const { store, discord, messages, sync } = await setup(t, { languageTracks: [track] }, { enabledLanguageCodes: [] });
    await sync();
    const series = store.getSeries("finished-new-dub");
    assert.equal(series.enabled, false);
    assert.equal(series.lateDubNotices.length, 0);
    assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now }), { posted: 0, failed: 0 });
    assert.equal(messages.length, 0);
  }
});

test("old or unconfirmed premiere evidence cannot reopen a finished title", async (t) => {
  for (const source of [
    { languageCode: "de", episode: 1, episodeEnd: 1, releaseAt: now.minus({ days: 15 }).toISO() },
    { languageCode: "de", episode: 1, episodeEnd: 1, releaseAt, requiresConfirmation: true }
  ]) {
    const { store, sync } = await setup(t);
    await sync({ lateDubReleases: [source] });
    const series = store.getSeries("finished-new-dub");
    assert.equal(series.enabled, false);
    assert.equal(series.lateDubNotices.length, 0);
    assert.equal(series.languageTracks.length, 0);
  }
});

test("metadata edits and disabling a title during its late post are preserved", async (t) => {
  const { store, discord, sync } = await setup(t);
  await sync();
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  let releaseSend;
  const pending = new Promise((resolve) => { releaseSend = resolve; });
  const originalPost = discord.post.bind(discord);
  t.mock.method(discord, "post", async (...args) => {
    notifyStarted();
    await pending;
    return originalPost(...args);
  });
  const posting = checkLateDubAnnouncements(store, discord, { now });
  await started;
  const edited = await store.upsertSeries({ ...store.getSeries("finished-new-dub"),
    enabled: false, note: "Edited while sending", tvdbId: "123456" }, { now });
  const beforeTracks = structuredClone(edited.languageTracks);
  releaseSend();
  assert.deepEqual(await posting, { posted: 1, failed: 0 });
  const saved = store.getSeries(edited.id);
  assert.equal(saved.enabled, false);
  assert.equal(saved.note, "Edited while sending");
  assert.equal(saved.tvdbId, "123456");
  assert.deepEqual(saved.languageTracks, beforeTracks);
  assert.ok(saved.lateDubNotices[0].notifiedAt);
});

test("a title deleted during its late post is not recreated", async (t) => {
  const { store, discord, sync } = await setup(t);
  await sync();
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  let releaseSend;
  const pending = new Promise((resolve) => { releaseSend = resolve; });
  const originalPost = discord.post.bind(discord);
  t.mock.method(discord, "post", async (...args) => {
    notifyStarted();
    await pending;
    return originalPost(...args);
  });
  const posting = checkLateDubAnnouncements(store, discord, { now });
  await started;
  await store.deleteSeries("finished-new-dub");
  releaseSend();
  await posting;
  assert.equal(store.getSeries("finished-new-dub"), null);
  assert.equal(store.listSeries().length, 0);
});
