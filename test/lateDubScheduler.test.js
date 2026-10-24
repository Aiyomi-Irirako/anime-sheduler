import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { createStore } from "../src/store.js";
import { createDiscordService } from "../src/discordBot.js";
import { checkLateDubAnnouncements } from "../src/scheduler.js";
import { syncOneSeriesFromLiveChart } from "../src/livechartSync.js";

const now = DateTime.fromISO("2026-10-25T00:26:00", { zone: "Europe/Berlin" });
const channelA = "111111111111111111";
const channelB = "222222222222222222";
const settings = { timeZone: "Europe/Berlin", automaticDiscordPostsEnabled: true,
  enabledLanguageCodes: ["de"], discordChannelIds: [channelA, channelB] };

// Minimal reproductions of two late-discovered dubs, with no backup-file dependency.
const examples = [
  { id: "appraisal-skill", title: "As a Reincarnated Aristocrat, I'll Use My Appraisal Skill to Rise in the World Season 3",
    scheduleLink: "https://www.livechart.me/anime/12991/schedules", nextDate: "2026-10-25" },
  { id: "apothecary-diaries", title: "The Apothecary Diaries Season 3 Cour 1",
    scheduleLink: "https://www.livechart.me/anime/99999/schedules", nextDate: "2026-10-30" }
];

function seriesFixture(example = examples[0]) {
  return { id: example.id, title: example.title, scheduleLink: example.scheduleLink,
    status: "planned", enabled: true, service: "Crunchyroll", nextEpisode: 5,
    nextDate: example.nextDate, releaseTime: "16:00", weekly: true,
    languageTracks: [{ code: "de", label: "German", enabled: true, available: true,
      nextEpisode: 2, nextDate: example.nextDate, releaseTime: "16:00", weekly: true,
      lastPostedKey: "", lastPostedAt: "", source: "Streaming: Dubbed" }] };
}

function pendingNotice(example = examples[0], overrides = {}) {
  return { key: `${example.id}:late:de:schedule`, languageCode: "de", kind: "schedule",
    episode: null, episodeEnd: null, releaseAt: "", nextEpisode: 2,
    nextReleaseAt: DateTime.fromISO(`${example.nextDate}T16:00:00`, { zone: settings.timeZone }).toISO(),
    detectedAt: now.toISO(), notifiedAt: "", sentChannelIds: [], ...overrides };
}

function preserveEnvironment(t) {
  const original = process.env.DISCORD_AUTO_POSTS;
  t.after(() => {
    if (original === undefined) delete process.env.DISCORD_AUTO_POSTS;
    else process.env.DISCORD_AUTO_POSTS = original;
  });
  delete process.env.DISCORD_AUTO_POSTS;
}

async function setup(t, series = [seriesFixture()]) {
  preserveEnvironment(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anime-late-dub-scheduler-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "isolated-db.json");
  const store = createStore(filePath);
  await store.init();
  // Restore itself must never invent notification history or queue old releases.
  await store.replaceData({ ...store.snapshot(), settings: { ...store.getSettings(), ...settings }, series });
  const discord = createDiscordService(store);
  discord.enabled = true;
  discord.ready = true;
  const sent = [];
  t.mock.method(discord, "sendToChannel", async (channelId, message) => {
    sent.push({ channelId, message });
    return { id: `fake-${sent.length}` };
  });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request"); });
  return { store, filePath, discord, sent };
}

function regularState(series) {
  const { lateDubNotices, updatedAt, ...rest } = series;
  return rest;
}

test("restoring the two late-discovered dubs alone queues and posts nothing", async (t) => {
  const { store, discord, sent } = await setup(t, examples.map(seriesFixture));
  for (const example of examples) assert.deepEqual(store.getSeries(example.id).lateDubNotices, []);
  assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now }), { posted: 0, failed: 0 });
  assert.equal(sent.length, 0);
});

test("late notices for both reproduced dubs post once without inventing an episode-one date", async (t) => {
  const { store, discord, sent } = await setup(t, examples.map(example => ({
    ...seriesFixture(example), lateDubNotices: [pendingNotice(example)]
  })));
  const before = examples.map(example => regularState(store.getSeries(example.id)));
  assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now }), { posted: 2, failed: 0 });
  assert.equal(sent.length, 4);
  for (const [index, example] of examples.entries()) {
    const saved = store.getSeries(example.id);
    assert.equal(saved.lateDubNotices.length, 1);
    assert.ok(saved.lateDubNotices[0].notifiedAt);
    assert.deepEqual(saved.lateDubNotices[0].sentChannelIds, [channelA, channelB]);
    assert.equal(saved.lateDubNotices[0].kind, "schedule");
    assert.equal(saved.lateDubNotices[0].releaseAt, "");
    assert.deepEqual(regularState(saved), before[index], "notification must not advance a scheduled release");
  }
  assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now: now.plus({ minutes: 1 }) }), { posted: 0, failed: 0 });
});

test("late notification receipts survive restart and backup restore without duplicate delivery", async (t) => {
  const { store, filePath, discord, sent } = await setup(t, [{
    ...seriesFixture(), lateDubNotices: [pendingNotice()]
  }]);
  assert.equal((await checkLateDubAnnouncements(store, discord, { now })).posted, 1);
  const reopened = createStore(filePath);
  await reopened.init();
  await reopened.replaceData(store.snapshot());
  assert.deepEqual(await checkLateDubAnnouncements(reopened, discord, { now: now.plus({ days: 1 }) }), { posted: 0, failed: 0 });
  assert.equal(sent.length, 2);
});

test("partial late-post failures retry only the undelivered channel after restart and a later normal post", async (t) => {
  const { store, filePath, discord, sent } = await setup(t, [{
    ...seriesFixture(), lateDubNotices: [pendingNotice()]
  }]);
  t.mock.method(console, "warn", () => {});
  const originalSend = discord.sendToChannel;
  const attempts = [];
  discord.sendToChannel = async (channelId, message) => {
    attempts.push(channelId);
    if (channelId === channelB) throw new Error("Missing permission");
    return originalSend(channelId, message);
  };
  assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now }), { posted: 1, failed: 1 });
  const pending = store.getSeries(examples[0].id).lateDubNotices[0];
  assert.equal(pending.notifiedAt, "");
  assert.deepEqual(pending.sentChannelIds, [channelA]);
  const reopened = createStore(filePath);
  await reopened.init();
  const current = reopened.getSeries(examples[0].id);
  await reopened.replaceSeries(current.id, { ...current, languageTracks: current.languageTracks.map(track =>
    track.code === "de" ? { ...track, lastPostedAt: now.toISO(),
      lastPostedKey: `${current.id}:language:de:1:release-time:${now.minus({ days: 6 }).toISO()}` } : track) });
  discord.sendToChannel = async (channelId, message) => {
    attempts.push(channelId);
    return originalSend(channelId, message);
  };
  assert.deepEqual(await checkLateDubAnnouncements(reopened, discord, { now: now.plus({ minutes: 1 }) }), { posted: 1, failed: 0 });
  assert.deepEqual(attempts, [channelA, channelB, channelB]);
  assert.deepEqual(sent.map(item => item.channelId), [channelA, channelB]);
  assert.deepEqual(await checkLateDubAnnouncements(reopened, discord, { now: now.plus({ minutes: 2 }) }), { posted: 0, failed: 0 });
});

test("a confirmed late release is delivered beyond the normal six-hour expiry without advancing the track", async (t) => {
  const oldRelease = now.minus({ days: 6 });
  const { store, discord, sent } = await setup(t, [{
    ...seriesFixture(), lateDubNotices: [pendingNotice(examples[0], {
      key: `${examples[0].id}:late:de:release:1`, kind: "release", episode: 1, episodeEnd: 1,
      releaseAt: oldRelease.toISO()
    })]
  }]);
  const before = regularState(store.getSeries(examples[0].id));
  assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now }), { posted: 1, failed: 0 });
  assert.equal(sent.length, 2);
  assert.deepEqual(regularState(store.getSeries(examples[0].id)), before);
});

test("a normal dub announcement suppresses a still-pending generic catch-up", async (t) => {
  const series = seriesFixture();
  series.languageTracks[0].lastPostedAt = now.minus({ minutes: 1 }).toISO();
  series.languageTracks[0].lastPostedKey = `${series.id}:language:de:1:release-time:${now.minus({ days: 6 }).toISO()}`;
  const { store, discord, sent } = await setup(t, [{ ...series, lateDubNotices: [pendingNotice()] }]);
  assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now }), { posted: 0, failed: 0 });
  assert.equal(sent.length, 0);
});

for (const disabled of ["series", "track"]) {
  test(`late notifications respect a disabled ${disabled}`, async (t) => {
    const series = { ...seriesFixture(), lateDubNotices: [pendingNotice()] };
    if (disabled === "series") series.enabled = false;
    if (disabled === "track") series.languageTracks[0].enabled = false;
    const { store, discord, sent } = await setup(t, [series]);
    assert.equal((await checkLateDubAnnouncements(store, discord, { now })).posted, 0);
    assert.equal(sent.length, 0);
  });
}

test("an explicitly enabled series track remains eligible when global discovery languages are empty", async (t) => {
  const { store, discord, sent } = await setup(t, [{ ...seriesFixture(), lateDubNotices: [pendingNotice()] }]);
  await store.updateSettings({ ...store.getSettings(), enabledLanguageCodes: [] });
  assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now }), { posted: 1, failed: 0 });
  assert.equal(sent.length, 2);
});

test("a future detection time cannot send a notice early", async (t) => {
  const { store, discord, sent } = await setup(t, [{ ...seriesFixture(),
    lateDubNotices: [pendingNotice(examples[0], { detectedAt: now.plus({ hours: 1 }).toISO() })] }]);
  const before = store.snapshot();
  assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now }), { posted: 0, failed: 0 });
  assert.deepEqual(store.snapshot(), before);
  assert.equal(sent.length, 0);
});

for (const guard of ["environment", "settings", "offline"]) {
  test(`late notification ${guard} guard leaves pending receipts untouched`, async (t) => {
    const { store, discord, sent } = await setup(t, [{ ...seriesFixture(), lateDubNotices: [pendingNotice()] }]);
    if (guard === "environment") process.env.DISCORD_AUTO_POSTS = "false";
    if (guard === "settings") await store.updateSettings({ ...store.getSettings(), automaticDiscordPostsEnabled: false });
    if (guard === "offline") discord.ready = false;
    const before = store.snapshot();
    const result = await checkLateDubAnnouncements(store, discord, { now });
    assert.equal(result.posted, 0);
    assert.equal(result.reason, guard === "offline" ? "discord_not_ready" : "automatic_posts_disabled");
    assert.deepEqual(store.snapshot(), before);
    assert.equal(sent.length, 0);
  });
}

test("a successful sync recognizes an already-started dub from the restored upcoming episode", async (t) => {
  const { store, discord, sent } = await setup(t);
  const series = store.getSeries(examples[0].id);
  const nextReleaseAt = DateTime.fromISO("2026-10-25T16:00:00", { zone: settings.timeZone });
  await syncOneSeriesFromLiveChart(store, series, { now, overwriteSchedule: true,
    async fetchEpisodes() {
      return { nextEpisode: 5, mainReleaseTimestamp: nextReleaseAt.toSeconds(),
        service: "Crunchyroll", languageTracks: [{ code: "de", enabled: false, available: true,
          nextEpisode: 2, episodeBatchSize: 1, releaseTimestamp: nextReleaseAt.toSeconds(),
          source: "Streaming: Dubbed" }] };
    }
  });
  const notices = store.getSeries(series.id).lateDubNotices;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "schedule");
  assert.equal(notices[0].languageCode, "de");
  assert.equal(notices[0].releaseAt, "");
  assert.equal((await checkLateDubAnnouncements(store, discord, { now })).posted, 1);
  assert.equal(sent.length, 2);
  assert.equal(store.getSeries(series.id).languageTracks.find(track => track.code === "de").nextEpisode, 2);
});

test("a postponed known dub stays suppressed across later sync, restart and backup restore", async (t) => {
  const { store, filePath, discord, sent } = await setup(t);
  const id = examples[0].id;
  const postponedAt = DateTime.fromISO("2026-11-01T16:00:00", { zone: settings.timeZone });
  const syncPostponed = (targetStore, checkedAt) => syncOneSeriesFromLiveChart(
    targetStore, targetStore.getSeries(id), { now: checkedAt, overwriteSchedule: true,
      async fetchEpisodes() {
        return { nextEpisode: 5, service: "Crunchyroll", languageTracks: [{
          code: "de", available: true, nextEpisode: 2, episodeBatchSize: 1,
          releaseTimestamp: postponedAt.toSeconds(), source: "Streaming: Dubbed"
        }] };
      }
    });

  await syncPostponed(store, now);
  const notice = store.getSeries(id).lateDubNotices[0];
  assert.equal(store.getSeries(id).lateDubNotices.length, 1);
  assert.equal(notice.kind, "schedule");
  assert.equal(notice.suppressed, true);
  assert.equal(notice.notifiedAt, "", "suppression must not claim a delivered message");
  assert.deepEqual(notice.sentChannelIds, []);
  assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now }), { posted: 0, failed: 0 });

  const tomorrow = now.plus({ days: 1 });
  await syncPostponed(store, tomorrow);
  assert.equal(store.getSeries(id).lateDubNotices.length, 1);
  assert.equal(store.getSeries(id).lateDubNotices[0].key, notice.key);
  assert.equal(store.getSeries(id).lateDubNotices[0].suppressed, true);
  assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now: tomorrow }), { posted: 0, failed: 0 });

  const reopened = createStore(filePath);
  await reopened.init();
  await reopened.replaceData(store.snapshot());
  await syncPostponed(reopened, tomorrow.plus({ hours: 1 }));
  assert.equal(reopened.getSeries(id).lateDubNotices[0].suppressed, true);
  assert.equal(reopened.getSeries(id).lateDubNotices[0].notifiedAt, "");
  assert.deepEqual(await checkLateDubAnnouncements(reopened, discord, { now: tomorrow.plus({ hours: 1 }) }),
    { posted: 0, failed: 0 });
  assert.equal(sent.length, 0);
});

test("saving a late original release does not queue a dub notice", async (t) => {
  const { store, discord, sent } = await setup(t, [{ ...seriesFixture(), languageTracks: [] }]);
  const series = store.getSeries(examples[0].id);
  await store.upsertSeries({ ...series, nextDate: now.minus({ days: 1 }).toISODate(), releaseTime: "16:00" }, { now });
  assert.deepEqual(store.getSeries(series.id).lateDubNotices, []);
  assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now }), { posted: 0, failed: 0 });
  assert.equal(sent.length, 0);
});
