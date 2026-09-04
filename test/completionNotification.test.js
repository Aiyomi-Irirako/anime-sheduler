import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { createStore } from "../src/store.js";
import { buildCompletionAnnouncement, createDiscordService } from "../src/discordBot.js";
import { checkCompletionAnnouncements, startScheduler } from "../src/scheduler.js";
import { getCompletionNotificationDate, shouldNotifyCompletion } from "../src/schedule.js";

const settings = { timeZone: "Europe/Berlin" };
const finishedAt = "2026-09-01T17:00:00+02:00";
const due = DateTime.fromISO("2026-09-08T17:00:00", { zone: settings.timeZone });
const channelA = "111111111111111111";
const channelB = "222222222222222222";
const completedSeries = {
  id: "victoria", title: "Victoria of Many Faces", service: "Crunchyroll",
  status: "finished", enabled: false, nextEpisode: null, episodeCount: 9,
  languageTracks: [], finishedAt
};

async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anime-sheduler-completion-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "db.json");
  const store = createStore(filePath);
  await store.init();
  await store.updateSettings({ ...store.getSettings(), ...settings, discordChannelIds: [channelA, channelB] });
  await store.upsertSeries({ ...completedSeries, ...overrides });
  // Exercise real multi-channel dispatch with only its network boundary replaced.
  const discord = createDiscordService(store);
  discord.enabled = true;
  discord.ready = true;
  const sent = [];
  t.mock.method(discord, "sendToChannel", async (channelId, message) => {
    sent.push({ channelId, message });
    return { id: `message-${sent.length}` };
  });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request"); });
  return { store, filePath, discord, sent };
}

test("completion notices are due exactly one local week later, independent of episode reminders", () => {
  const configured = { ...settings, reminderMinutes: 60, missingTimePostTime: "18:00" };
  assert.equal(getCompletionNotificationDate(completedSeries, configured).toISO(), due.toISO());
  assert.equal(shouldNotifyCompletion(completedSeries, configured, due.minus({ milliseconds: 1 })), false);
  assert.equal(shouldNotifyCompletion(completedSeries, configured, due), true);
  assert.equal(shouldNotifyCompletion(completedSeries, configured, due.plus({ days: 2 })), true);
  assert.equal(shouldNotifyCompletion({ ...completedSeries, completionNotifiedAt: due.toISO() }, configured, due), false);
  const acrossDst = { ...completedSeries, finishedAt: "2026-10-20T15:00:00Z" };
  assert.equal(getCompletionNotificationDate(acrossDst, settings).toISO(), "2026-10-27T17:00:00.000+01:00");
});

test("unfinished releases, pending dubs and missing completion dates do not produce notices", () => {
  for (const patch of [
    { status: "airing" }, { nextEpisode: 9 }, { finishedAt: "" }, { finishedAt: "invalid" },
    { languageTracks: [{ code: "de", enabled: true, nextEpisode: 9 }] }
  ]) {
    assert.equal(shouldNotifyCompletion({ ...completedSeries, ...patch }, settings, due), false);
  }
  assert.equal(shouldNotifyCompletion({ ...completedSeries,
    languageTracks: [{ code: "de", enabled: false, nextEpisode: 9 }]
  }, settings, due), true);
});

test("completion embeds include full title, total episodes, preferred service and copy fields", () => {
  const message = buildCompletionAnnouncement({
    ...completedSeries, title: "Example Season 2", service: "Crunchyroll, aniverse", preferredService: "aniverse",
    streamingServiceId: "ABC123", scheduleLink: "https://www.livechart.me/anime/13315/schedules",
    imageUrl: "https://example.com/poster.jpg"
  }, settings, due);
  const embed = message.embeds[0].toJSON();
  assert.equal(embed.title, "Example Season 2 - Completed");
  assert.match(embed.description, /has finished/);
  assert.equal(embed.fields.find((field) => field.name === "Episodes").value, "9");
  assert.equal(embed.fields.find((field) => field.name === "Service").value, "aniverse");
  assert.equal(embed.fields.find((field) => field.name === "Finished").value, "Tue, 01 Sep 2026");
  assert.equal(embed.fields.find((field) => field.name === "Title").value, "```text\nExample\n```");
  assert.equal(embed.fields.find((field) => field.name === "Service ID").value, "```text\nABC123\n```");
  assert.equal(embed.thumbnail.url, "https://example.com/poster.jpg");
  assert.equal(embed.url, "https://www.livechart.me/anime/13315/schedules");
  assert.deepEqual(message.allowedMentions, { parse: [] });
  const unknown = buildCompletionAnnouncement({ ...completedSeries, episodeCount: null, service: "" }, settings, due)
    .embeds[0].toJSON();
  assert.equal(unknown.fields.find((field) => field.name === "Episodes").value, "Unknown");
  assert.equal(unknown.fields.find((field) => field.name === "Service").value, "Unknown");
  assert.equal(unknown.fields.some((field) => field.name === "Service ID"), false);
});

test("sends once at the boundary, with no duplicate after reload, backup restore or series edit", async (t) => {
  const { store, filePath, discord, sent } = await setup(t);
  const changesBefore = store.snapshot().changeLog.length;
  assert.equal((await checkCompletionAnnouncements(store, discord, { now: due.minus({ seconds: 1 }) })).posted, 0);
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: due }), { posted: 1, failed: 0 });
  assert.equal(sent.length, 2);
  assert.equal(store.getSeries("victoria").completionNotifiedAt, due.toISO());
  assert.deepEqual(store.getSeries("victoria").completionNotifiedChannelIds, [channelA, channelB]);
  assert.equal(store.snapshot().posts[0].type, "auto-completed");
  assert.equal(store.snapshot().posts[0].episodeCount, 9);
  assert.equal(store.snapshot().changeLog.length, changesBefore);

  const reopened = createStore(filePath);
  await reopened.init();
  await reopened.replaceData(store.snapshot());
  const { completionNotifiedAt, completionNotifiedChannelIds, ...edit } = reopened.getSeries("victoria");
  await reopened.upsertSeries({ ...edit, note: "Edited after completion" });
  assert.equal((await checkCompletionAnnouncements(reopened, discord, { now: due.plus({ days: 1 }) })).posted, 0);
  assert.equal(sent.length, 2);
});

test("offline and failed sends stay pending and are caught up later", async (t) => {
  const { store, discord, sent } = await setup(t);
  t.mock.method(console, "warn", () => {});
  discord.ready = false;
  assert.equal((await checkCompletionAnnouncements(store, discord, { now: due })).reason, "discord_not_ready");
  discord.ready = true;
  const originalSend = discord.sendToChannel;
  discord.sendToChannel = async () => { throw new Error("Discord unavailable"); };
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: due }), { posted: 0, failed: 1 });
  assert.equal(store.getSeries("victoria").completionNotifiedAt, "");
  assert.deepEqual(store.getSeries("victoria").completionNotifiedChannelIds, []);
  discord.sendToChannel = originalSend;
  assert.equal((await checkCompletionAnnouncements(store, discord, { now: due.plus({ days: 1 }) })).posted, 1);
  assert.equal(sent.length, 2);
});

test("partial channel failures retry only undelivered channels, including after a restart", async (t) => {
  const { store, filePath, discord, sent } = await setup(t);
  t.mock.method(console, "warn", () => {});
  const originalSend = discord.sendToChannel;
  discord.sendToChannel = async (channelId, message) => {
    if (channelId === channelB) throw new Error("Missing permission");
    return originalSend(channelId, message);
  };
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: due }), { posted: 1, failed: 1 });
  assert.equal(store.getSeries("victoria").completionNotifiedAt, "");
  assert.deepEqual(store.getSeries("victoria").completionNotifiedChannelIds, [channelA]);
  const reopened = createStore(filePath);
  await reopened.init();
  discord.sendToChannel = originalSend;
  assert.deepEqual(await checkCompletionAnnouncements(reopened, discord, { now: due.plus({ minutes: 1 }) }), { posted: 1, failed: 0 });
  assert.deepEqual(sent.map((item) => item.channelId), [channelA, channelB]);
  assert.equal((await checkCompletionAnnouncements(reopened, discord, { now: due.plus({ minutes: 2 }) })).posted, 0);
});

test("reactivating a series for a delayed dub starts a new completion cycle", async (t) => {
  const { store, discord } = await setup(t);
  await checkCompletionAnnouncements(store, discord, { now: due });
  await store.upsertSeries({ ...store.getSeries("victoria"), enabled: true,
    languageTracks: [{ code: "de", enabled: true, available: true, nextEpisode: 9 }]
  });
  assert.equal(store.getSeries("victoria").finishedAt, "");
  assert.equal(store.getSeries("victoria").completionNotifiedAt, "");
  assert.deepEqual(store.getSeries("victoria").completionNotifiedChannelIds, []);
  assert.equal((await checkCompletionAnnouncements(store, discord, { now: due })).posted, 0);

  await store.upsertSeries({ ...store.getSeries("victoria"), finishedAt: due.toISO(),
    languageTracks: [{ code: "de", enabled: false, available: true, nextEpisode: null }]
  });
  assert.equal((await checkCompletionAnnouncements(store, discord, { now: due.plus({ days: 6 }) })).posted, 0);
  assert.equal((await checkCompletionAnnouncements(store, discord, { now: due.plus({ weeks: 1 }) })).posted, 1);
});

test("a failed series does not block other due completion notices", async (t) => {
  const { store, discord, sent } = await setup(t);
  t.mock.method(console, "warn", () => {});
  await store.upsertSeries({ ...completedSeries, id: "another", title: "Another Series" });
  const originalSend = discord.sendToChannel;
  discord.sendToChannel = async (channelId, message) => {
    if (message.embeds[0].data.title.startsWith("Victoria")) throw new Error("Send failed");
    return originalSend(channelId, message);
  };
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: due }), { posted: 1, failed: 1 });
  assert.equal(sent.length, 2);
  assert.ok(store.getSeries("another").completionNotifiedAt);
  assert.equal(store.getSeries("victoria").completionNotifiedAt, "");
});

test("scheduled ticks cannot overlap while a Discord send is pending", async (t) => {
  const { store, discord, sent } = await setup(t, { finishedAt: DateTime.now().minus({ days: 8 }).toISO() });
  let tick;
  t.mock.method(globalThis, "setInterval", (callback) => { tick = callback; return "fake-timer"; });
  t.mock.method(console, "log", () => {});
  let releasePost;
  const pending = new Promise((resolve) => { releasePost = resolve; });
  let postStarted;
  const started = new Promise((resolve) => { postStarted = resolve; });
  let savedPost;
  const saved = new Promise((resolve) => { savedPost = resolve; });
  const originalLog = store.addPostLog.bind(store);
  t.mock.method(store, "addPostLog", async (entry) => { await originalLog(entry); savedPost(); });
  const originalPost = discord.post.bind(discord);
  let attempts = 0;
  t.mock.method(discord, "post", async (...args) => {
    attempts += 1;
    postStarted();
    await pending;
    return originalPost(...args);
  });
  startScheduler(store, discord);
  await started;
  await tick();
  assert.equal(attempts, 1);
  releasePost();
  await saved;
  assert.equal(sent.length, 2);
});
