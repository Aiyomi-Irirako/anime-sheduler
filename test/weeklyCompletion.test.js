import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { createStore } from "../src/store.js";
import { createDiscordService } from "../src/discordBot.js";
import { checkCompletionAnnouncements, checkCompletionDigestAnnouncements } from "../src/scheduler.js";
import { syncOneSeriesFromLiveChart } from "../src/livechartSync.js";
import {
  getCompletionNotificationDate,
  getCompletionNotificationCycleDate,
  getCompletionDigestCycleDate,
  getNextCompletionDigestDate,
  shouldNotifyCompletion
} from "../src/schedule.js";

const settings = { timeZone: "Europe/Berlin", completionDigestDay: "sunday", completionDigestTime: "18:00" };
const due = DateTime.fromISO("2026-09-08T17:00:00", { zone: settings.timeZone });
const digestDue = DateTime.fromISO("2026-09-13T18:00:00", { zone: settings.timeZone });
const channelA = "111111111111111111";
const channelB = "222222222222222222";
const completedSeries = {
  id: "weekly-completed", title: "Weekly completed series", service: "ADN",
  status: "finished", enabled: false, nextEpisode: null, episodeCount: 12,
  languageTracks: [], finishedAt: due.minus({ weeks: 1 }).toISO()
};

async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anime-sheduler-weekly-completion-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "db.json");
  const store = createStore(filePath);
  await store.init();
  await store.updateSettings({
    ...store.getSettings(), ...settings,
    automaticDiscordPostsEnabled: true, discordChannelIds: [channelA, channelB]
  });
  await store.upsertSeries({ ...completedSeries, ...overrides });
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

function completionState(series) {
  return Object.fromEntries([
    "finishedAt", "completionAcknowledged", "completionAcknowledgedAt",
    "completionNotifiedAt", "completionNotificationCycleAt", "completionNotifiedChannelIds"
  ].map((field) => [field, series[field]]));
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("individual completion notices stay due until first delivery and are never repeated", () => {
  assert.equal(getCompletionNotificationDate(completedSeries, settings).toISO(), due.toISO());
  assert.equal(getCompletionNotificationCycleDate(completedSeries, settings, due.minus({ seconds: 1 })), null);
  assert.equal(getCompletionNotificationCycleDate(completedSeries, settings, due.plus({ weeks: 4, days: 2 })).toISO(), due.toISO());

  const sentLate = {
    ...completedSeries, completionNotifiedAt: due.plus({ days: 1 }).toISO(),
    completionNotificationCycleAt: due.toISO()
  };
  assert.equal(getCompletionNotificationDate(sentLate, settings), null);
  assert.equal(shouldNotifyCompletion(sentLate, settings, due.plus({ weeks: 1 })), false);

  const legacy = { ...completedSeries, completionNotifiedAt: due.plus({ days: 1 }).toISO() };
  assert.equal(getCompletionNotificationDate(legacy, settings), null);
  assert.equal(shouldNotifyCompletion(legacy, settings, due.plus({ weeks: 10 })), false);
});

test("all open completions share one configured weekly digest per channel", async (t) => {
  const { store, discord, sent } = await setup(t);
  await store.upsertSeries({ ...completedSeries, id: "another-completed", title: "Another completed series Season 2" });
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: due }), { posted: 2, failed: 0 });
  assert.equal(sent.length, 4, "first notices stay individual");
  assert.equal((await checkCompletionAnnouncements(store, discord, { now: digestDue.minus({ milliseconds: 1 }) })).posted, 0);
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: digestDue }), { posted: 1, failed: 0 });
  assert.equal(sent.length, 6);
  for (const { message } of sent.slice(4)) {
    const description = message.embeds[0].toJSON().description;
    assert.match(description, /2 completed series/);
    assert.match(description, /Another completed series Season 2/);
    assert.match(description, /Weekly completed series/);
    assert.ok(description.indexOf("Another") < description.indexOf("Weekly"));
    assert.deepEqual(message.allowedMentions, { parse: [] });
  }
  assert.equal(store.getSeries(completedSeries.id).completionNotifiedAt, due.toISO());
  assert.equal(store.snapshot().posts.filter(({ type }) => type === "auto-completion-digest").length, 1);
  assert.equal((await checkCompletionAnnouncements(store, discord, { now: digestDue.plus({ days: 6 }) })).posted, 0);
});

test("digest delivery state prevents duplicates after restart and backup restore", async (t) => {
  const { store, filePath, discord, sent } = await setup(t);
  await checkCompletionAnnouncements(store, discord, { now: due });
  await checkCompletionAnnouncements(store, discord, { now: digestDue });
  const reopened = createStore(filePath);
  await reopened.init();
  await reopened.replaceData(store.snapshot());
  assert.equal((await checkCompletionAnnouncements(reopened, discord, { now: digestDue.plus({ days: 1 }) })).posted, 0);
  assert.deepEqual(await checkCompletionAnnouncements(reopened, discord, { now: digestDue.plus({ weeks: 1 }) }), { posted: 1, failed: 0 });
  assert.equal(reopened.getCompletionDigest().cycleAt, digestDue.plus({ weeks: 1 }).toISO());
  const restored = createStore(filePath);
  await restored.init();
  await restored.replaceData(reopened.snapshot());
  assert.equal((await checkCompletionAnnouncements(restored, discord, { now: digestDue.plus({ weeks: 1, days: 1 }) })).posted, 0);
  assert.deepEqual(await checkCompletionAnnouncements(restored, discord, { now: digestDue.plus({ weeks: 2 }) }), { posted: 1, failed: 0 });
  assert.deepEqual(sent.map(({ channelId }) => channelId), [channelA, channelB, channelA, channelB, channelA, channelB, channelA, channelB]);
  assert.equal(restored.snapshot().posts.filter(({ type }) => type === "auto-completed").length, 1);
  assert.equal(restored.snapshot().posts.filter(({ type }) => type === "auto-completion-digest").length, 3);
});

test("legacy once-sent backups join the digest without another individual notice", async (t) => {
  const { store, filePath, discord, sent } = await setup(t);
  const snapshot = store.snapshot();
  const entry = snapshot.series[0];
  entry.completionNotifiedAt = due.toISO();
  entry.completionNotifiedChannelIds = [channelA, channelB];
  delete entry.completionNotificationCycleAt;
  delete entry.completionAcknowledged;
  delete entry.completionAcknowledgedAt;
  await fs.writeFile(filePath, JSON.stringify(snapshot), "utf8");
  const legacy = createStore(filePath);
  await legacy.init();

  assert.equal(legacy.getSeries(completedSeries.id).completionAcknowledged, false);
  assert.equal((await checkCompletionAnnouncements(legacy, discord, { now: due })).posted, 0);
  assert.equal((await checkCompletionAnnouncements(legacy, discord, { now: digestDue.minus({ seconds: 1 }) })).posted, 0);
  assert.deepEqual(await checkCompletionAnnouncements(legacy, discord, { now: digestDue }), { posted: 1, failed: 0 });
  assert.equal(sent.length, 2);
  assert.equal(legacy.getSeries(completedSeries.id).completionNotifiedAt, due.toISO());
  assert.equal(legacy.snapshot().posts.some(({ type }) => type === "auto-completed"), false);
  assert.equal((await checkCompletionAnnouncements(legacy, discord, { now: digestDue.plus({ minutes: 1 }) })).posted, 0);
});

test("long downtime catches up only the latest digest and keeps the configured next boundary", async (t) => {
  const { store, discord, sent } = await setup(t, { completionNotifiedAt: due.toISO() });
  discord.ready = false;
  const resumedAt = due.plus({ weeks: 10, days: 2 });
  assert.equal((await checkCompletionAnnouncements(store, discord, { now: resumedAt })).reason, "discord_not_ready");
  assert.equal(store.getSeries(completedSeries.id).completionNotifiedAt, due.toISO());
  discord.ready = true;
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: resumedAt }), { posted: 1, failed: 0 });
  assert.equal(sent.length, 2);
  assert.equal(store.getCompletionDigest().cycleAt, getCompletionDigestCycleDate(settings, resumedAt).toISO());
  assert.equal(store.getCompletionDigest().completedAt, resumedAt.toISO());
  assert.equal((await checkCompletionAnnouncements(store, discord, { now: resumedAt.plus({ minutes: 1 }) })).posted, 0);
  const next = getNextCompletionDigestDate(settings, resumedAt);
  assert.equal((await checkCompletionAnnouncements(store, discord, { now: next.minus({ seconds: 1 }) })).posted, 0);
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: next }), { posted: 1, failed: 0 });
  assert.equal(sent.length, 4);
});

test("partial digest sends retry only failed channels and reset receipts next week", async (t) => {
  const { store, filePath, discord, sent } = await setup(t);
  t.mock.method(console, "warn", () => {});
  await checkCompletionAnnouncements(store, discord, { now: due });
  const originalSend = discord.sendToChannel;
  const attempts = [];
  discord.sendToChannel = async (channelId, message) => {
    attempts.push(channelId);
    if (channelId === channelB) throw new Error("Missing permission");
    return originalSend(channelId, message);
  };
  const weekTwo = digestDue;
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: weekTwo }), { posted: 1, failed: 1 });
  assert.equal(store.getSeries(completedSeries.id).completionNotifiedAt, due.toISO());
  assert.equal(store.getCompletionDigest().cycleAt, weekTwo.toISO());
  assert.equal(store.getCompletionDigest().completedAt, "");
  assert.deepEqual(store.getCompletionDigest().sentChannelIds, [channelA]);
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: weekTwo.plus({ minutes: 1 }) }), { posted: 0, failed: 1 });
  assert.deepEqual(attempts, [channelA, channelB, channelB]);

  const reopened = createStore(filePath);
  await reopened.init();
  const weekThree = digestDue.plus({ weeks: 1 });
  assert.deepEqual(await checkCompletionAnnouncements(reopened, discord, { now: weekThree }), { posted: 1, failed: 1 });
  assert.deepEqual(attempts, [channelA, channelB, channelB, channelA, channelB]);
  assert.equal(reopened.getCompletionDigest().cycleAt, weekThree.toISO());
  discord.sendToChannel = originalSend;
  assert.deepEqual(await checkCompletionAnnouncements(reopened, discord, { now: weekThree.plus({ minutes: 1 }) }), { posted: 1, failed: 0 });
  assert.deepEqual(sent.map(({ channelId }) => channelId), [channelA, channelB, channelA, channelA, channelB]);
  assert.equal(reopened.getCompletionDigest().completedAt, weekThree.plus({ minutes: 1 }).toISO());
  assert.equal((await checkCompletionAnnouncements(reopened, discord, { now: weekThree.plus({ days: 1 }) })).posted, 0);
});

test("legacy partial initial receipts survive late retries without duplicate successful channels", async (t) => {
  const { store, discord, sent } = await setup(t, { completionNotifiedChannelIds: [channelA] });
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: due.plus({ days: 1 }) }), { posted: 1, failed: 0 });
  assert.deepEqual(sent.map(({ channelId }) => channelId), [channelB]);
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: digestDue }), { posted: 1, failed: 0 });
  assert.deepEqual(sent.map(({ channelId }) => channelId), [channelB, channelA, channelB]);
});

test("legacy partial receipts remain assigned to the initial notice after missed weeks", async (t) => {
  const { store, discord, sent } = await setup(t, { completionNotifiedChannelIds: [channelA] });
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: due.plus({ weeks: 3 }) }), { posted: 1, failed: 0 });
  assert.deepEqual(sent.map(({ channelId }) => channelId), [channelB]);
  assert.equal(store.getSeries(completedSeries.id).completionNotificationCycleAt, due.toISO());
  const next = getNextCompletionDigestDate(settings, due.plus({ weeks: 3 }));
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: next }), { posted: 1, failed: 0 });
  assert.deepEqual(sent.map(({ channelId }) => channelId), [channelB, channelA, channelB]);
});

test("empty rounds close and unchecking waits for the next scheduled digest", async (t) => {
  const { store, filePath, discord, sent } = await setup(t);
  await checkCompletionAnnouncements(store, discord, { now: due });
  await store.upsertSeries({ ...store.getSeries(completedSeries.id), completionAcknowledged: true });
  assert.equal(store.getSeries(completedSeries.id).completionAcknowledged, true);
  assert.ok(DateTime.fromISO(store.getSeries(completedSeries.id).completionAcknowledgedAt).isValid);
  assert.equal(getCompletionNotificationDate(store.getSeries(completedSeries.id), settings), null);
  assert.equal((await checkCompletionAnnouncements(store, discord, { now: digestDue })).posted, 0);
  assert.equal(store.getCompletionDigest().cycleAt, digestDue.toISO());
  assert.equal(store.getCompletionDigest().completedAt, digestDue.toISO());
  const reopened = createStore(filePath);
  await reopened.init();
  await reopened.replaceData(store.snapshot());
  assert.equal((await checkCompletionAnnouncements(reopened, discord, { now: digestDue.plus({ days: 1 }) })).posted, 0);
  assert.equal(sent.length, 2);

  await reopened.upsertSeries({ ...reopened.getSeries(completedSeries.id), completionAcknowledged: false });
  assert.equal(reopened.getSeries(completedSeries.id).completionAcknowledgedAt, "");
  assert.equal((await checkCompletionAnnouncements(reopened, discord, { now: digestDue.plus({ days: 1 }) })).posted, 0);
  assert.deepEqual(await checkCompletionAnnouncements(reopened, discord, { now: digestDue.plus({ weeks: 1 }) }), { posted: 1, failed: 0 });
  assert.equal(sent.length, 4);
});

test("a first notice sent at the digest time enters only the following weekly post", async (t) => {
  const { store, discord, sent } = await setup(t, { finishedAt: digestDue.minus({ weeks: 1 }).toISO() });
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: digestDue }), { posted: 1, failed: 0 });
  assert.equal(sent.length, 2);
  assert.match(sent[0].message.embeds[0].toJSON().title, /Completed$/);
  assert.equal((await checkCompletionAnnouncements(store, discord, { now: digestDue.plus({ days: 1 }) })).posted, 0);
  assert.deepEqual(await checkCompletionAnnouncements(store, discord, { now: digestDue.plus({ weeks: 1 }) }), { posted: 1, failed: 0 });
  assert.equal(sent.length, 4);
  assert.equal(sent[2].message.embeds[0].toJSON().title, "Open completion reminders");
});

test("digest safety guards honor offline Discord and the automatic posting setting", async (t) => {
  const { store, discord, sent } = await setup(t, { completionNotifiedAt: due.toISO() });
  discord.ready = false;
  assert.equal((await checkCompletionDigestAnnouncements(store, discord, { now: digestDue })).reason, "discord_not_ready");
  discord.ready = true;
  await store.updateSettings({ ...store.getSettings(), automaticDiscordPostsEnabled: false });
  assert.equal((await checkCompletionDigestAnnouncements(store, discord, { now: digestDue })).reason, "automatic_posts_disabled");
  assert.equal(sent.length, 0);
  assert.equal(store.getCompletionDigest().cycleAt, "");
});

for (const action of ["backup restore", "progress update"]) {
  test(`an in-flight digest cannot overwrite newer progress from a ${action}`, async (t) => {
    const { store, discord } = await setup(t, { completionNotifiedAt: due.toISO() });
    const started = deferred();
    const release = deferred();
    const originalPost = discord.post.bind(discord);
    t.mock.method(discord, "post", async (...args) => {
      started.resolve();
      await release.promise;
      return originalPost(...args);
    });
    const checking = checkCompletionDigestAnnouncements(store, discord, { now: digestDue });
    await started.promise;
    const latest = {
      cycleAt: digestDue.plus({ weeks: 1 }).toISO(),
      sentChannelIds: [channelB],
      completedAt: digestDue.plus({ weeks: 1, minutes: 1 }).toISO()
    };
    if (action === "backup restore") {
      await store.replaceData({ ...store.snapshot(), completionDigest: latest });
    } else {
      await store.updateCompletionDigest(latest);
    }
    release.resolve();
    assert.deepEqual(await checking, { posted: 1, failed: 0 });
    assert.deepEqual(store.getCompletionDigest(), latest);
    assert.equal(store.snapshot().posts.some(({ type }) => type === "auto-completion-digest"), false);
  });
}

test("confirmations and deletions during a digest send remain intact", async (t) => {
  const { store, discord } = await setup(t, { completionNotifiedAt: due.toISO() });
  const second = await store.upsertSeries({
    ...completedSeries, id: "deleted-completed", title: "Deleted completed series", completionNotifiedAt: due.toISO()
  });
  const started = deferred();
  const release = deferred();
  const originalPost = discord.post.bind(discord);
  t.mock.method(discord, "post", async (...args) => {
    started.resolve();
    await release.promise;
    return originalPost(...args);
  });
  const checking = checkCompletionDigestAnnouncements(store, discord, { now: digestDue });
  await started.promise;
  await store.upsertSeries({ ...store.getSeries(completedSeries.id), completionAcknowledged: true });
  const acknowledged = completionState(store.getSeries(completedSeries.id));
  await store.deleteSeries(second.id);
  release.resolve();
  assert.deepEqual(await checking, { posted: 1, failed: 0 });
  assert.deepEqual(completionState(store.getSeries(completedSeries.id)), acknowledged);
  assert.equal(store.getSeries(second.id), null);
});

test("checking completion while a send is in flight does not overwrite the confirmation", async (t) => {
  const { store, discord } = await setup(t);
  const started = deferred();
  const release = deferred();
  const originalPost = discord.post.bind(discord);
  t.mock.method(discord, "post", async (...args) => {
    started.resolve();
    await release.promise;
    return originalPost(...args);
  });
  const checking = checkCompletionAnnouncements(store, discord, { now: due });
  await started.promise;
  await store.upsertSeries({ ...store.getSeries(completedSeries.id), completionAcknowledged: true });
  const acknowledged = completionState(store.getSeries(completedSeries.id));
  release.resolve();
  await checking;
  assert.deepEqual(completionState(store.getSeries(completedSeries.id)), acknowledged);
  assert.equal((await checkCompletionAnnouncements(store, discord, { now: due.plus({ weeks: 1 }) })).posted, 0);
});

test("reopening a completed series during a send does not restore stale completion state", async (t) => {
  const { store, discord } = await setup(t);
  const started = deferred();
  const release = deferred();
  const originalPost = discord.post.bind(discord);
  t.mock.method(discord, "post", async (...args) => {
    started.resolve();
    await release.promise;
    return originalPost(...args);
  });
  const checking = checkCompletionAnnouncements(store, discord, { now: due });
  await started.promise;
  await store.upsertSeries({
    ...store.getSeries(completedSeries.id), status: "airing", enabled: true,
    nextEpisode: 13, episodeCount: 24
  });
  const reopened = completionState(store.getSeries(completedSeries.id));
  release.resolve();
  await checking;
  assert.deepEqual(completionState(store.getSeries(completedSeries.id)), reopened);
  assert.equal(store.getSeries(completedSeries.id).nextEpisode, 13);
  assert.equal(store.getSeries(completedSeries.id).finishedAt, "");
});

test("metadata edits during a completion send are preserved alongside its delivery state", async (t) => {
  const { store, discord } = await setup(t);
  const started = deferred();
  const release = deferred();
  const originalPost = discord.post.bind(discord);
  t.mock.method(discord, "post", async (...args) => {
    started.resolve();
    await release.promise;
    return originalPost(...args);
  });
  const checking = checkCompletionAnnouncements(store, discord, { now: due });
  await started.promise;
  await store.upsertSeries({ ...store.getSeries(completedSeries.id), note: "Edited during send", tvdbId: "123456" });
  release.resolve();
  assert.deepEqual(await checking, { posted: 1, failed: 0 });
  assert.equal(store.getSeries(completedSeries.id).note, "Edited during send");
  assert.equal(store.getSeries(completedSeries.id).tvdbId, "123456");
  assert.equal(store.getSeries(completedSeries.id).completionNotificationCycleAt, due.toISO());
});

for (const action of ["confirmation", "notification"]) {
  test(`an in-flight LiveChart sync cannot undo a newer completion ${action}`, async (t) => {
    const { store, discord } = await setup(t, { scheduleLink: "https://www.livechart.me/anime/13315/schedules" });
    const started = deferred();
    const fetched = deferred();
    const syncing = syncOneSeriesFromLiveChart(store, store.getSeries(completedSeries.id), {
      overwriteSchedule: true, now: due,
      async fetchEpisodes() {
        started.resolve();
        return fetched.promise;
      }
    });
    await started.promise;
    if (action === "confirmation") {
      await store.upsertSeries({ ...store.getSeries(completedSeries.id), completionAcknowledged: true });
    } else {
      await checkCompletionAnnouncements(store, discord, { now: due });
    }
    const latest = completionState(store.getSeries(completedSeries.id));
    fetched.resolve({ episodeCount: 13, mainFinished: true, service: "ADN, aniverse", languageTracks: [] });
    await syncing;
    assert.equal(store.getSeries(completedSeries.id).episodeCount, 13);
    assert.deepEqual(completionState(store.getSeries(completedSeries.id)), latest);
    assert.equal((await checkCompletionAnnouncements(store, discord, { now: due.plus({ minutes: 1 }) })).posted, 0);
  });
}
