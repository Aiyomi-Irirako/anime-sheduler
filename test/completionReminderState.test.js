import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { createStore } from "../src/store.js";
import {
  getCompletionNotificationDate,
  getCompletionNotificationCycleDate,
  getCompletionDigestCycleDate,
  getNextCompletionDigestDate,
  getFinishedDeletionDate,
  shouldNotifyCompletion
} from "../src/schedule.js";

const settings = { timeZone: "Europe/Berlin" };
const date = (value) => DateTime.fromISO(value, { zone: settings.timeZone });
const finishedAt = "2026-09-01T17:00:00+02:00";
const first = date("2026-09-08T17:00:00");
const completed = { id: "completed", title: "Completed Series", service: "Crunchyroll",
  status: "finished", enabled: false, nextEpisode: null, episodeCount: 12,
  languageTracks: [], finishedAt };
const channelA = "111111111111111111";
const channelB = "222222222222222222";

async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anime-sheduler-reminder-state-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "db.json");
  const store = createStore(filePath);
  await store.init();
  await store.upsertSeries({ ...completed, ...overrides });
  return { store, filePath };
}

test("completion cycles start after a local week and respect the exact boundary", () => {
  assert.equal(getCompletionNotificationDate(completed, settings).toISO(), first.toISO());
  assert.equal(getCompletionNotificationCycleDate(completed, settings, first.minus({ milliseconds: 1 })), null);
  assert.equal(shouldNotifyCompletion(completed, settings, first), true);
  assert.equal(getCompletionNotificationCycleDate(completed, settings, first).toISO(), first.toISO());
});

test("the individual completion notice stops after successful delivery while partial sends stay due", () => {
  const partial = { ...completed, completionNotificationCycleAt: first.toISO(),
    completionNotifiedAt: "", completionNotifiedChannelIds: [channelA] };
  assert.equal(getCompletionNotificationDate(partial, settings).toISO(), first.toISO());
  const sent = { ...partial, completionNotifiedAt: first.plus({ minutes: 2 }).toISO() };
  assert.equal(getCompletionNotificationDate(sent, settings), null);
  assert.equal(shouldNotifyCompletion(sent, settings, first.plus({ days: 6 })), false);
  assert.equal(shouldNotifyCompletion(sent, settings, first.plus({ weeks: 1 })), false);
  const secondPartial = { ...sent, completionNotificationCycleAt: first.plus({ weeks: 1 }).toISO() };
  assert.equal(getCompletionNotificationDate(secondPartial, settings), null);
});

test("an overdue individual notice retains its first due date, including after partial failure", () => {
  const overdue = first.plus({ weeks: 8, days: 3 });
  for (const entry of [completed, { ...completed, completionNotificationCycleAt: first.toISO(),
    completionNotifiedChannelIds: [channelA] }]) {
    assert.equal(getCompletionNotificationCycleDate(entry, settings, overdue).toISO(), first.toISO());
  }
  const caughtUp = { ...completed, completionNotificationCycleAt: first.toISO(), completionNotifiedAt: overdue.toISO() };
  assert.equal(shouldNotifyCompletion(caughtUp, settings, overdue), false);
  assert.equal(getCompletionNotificationDate(caughtUp, settings), null);
});

test("weekly dates preserve local wall time over daylight saving changes", () => {
  for (const [finished, expected] of [
    ["2026-10-20T15:00:00Z", "2026-10-27T17:00:00.000+01:00"],
    ["2026-03-24T16:00:00Z", "2026-03-31T17:00:00.000+02:00"]
  ]) {
    const entry = { ...completed, finishedAt: finished };
    const due = getCompletionNotificationDate(entry, settings);
    assert.equal(due.toISO(), expected);
    assert.equal(getCompletionNotificationCycleDate(entry, settings, due.plus({ weeks: 5, hours: 1 })).toISO(),
      due.toISO());
  }
});

test("legacy successful notices are already delivered and invalid receipts remain due", () => {
  const lastSent = first.plus({ days: 2 });
  const legacy = { ...completed, completionNotifiedAt: lastSent.toISO(), completionNotifiedChannelIds: [channelA] };
  assert.equal(getCompletionNotificationDate(legacy, settings), null);
  assert.equal(shouldNotifyCompletion(legacy, settings, lastSent.plus({ days: 6 })), false);
  assert.equal(shouldNotifyCompletion(legacy, settings, lastSent.plus({ weeks: 1 })), false);
  assert.equal(getCompletionNotificationDate({ ...legacy, completionNotifiedAt: finishedAt }, settings), null);
  for (const value of ["invalid", ""]) {
    assert.equal(getCompletionNotificationDate({ ...completed, completionNotifiedAt: value,
      completionNotificationCycleAt: "invalid" }, settings).toISO(), first.toISO());
  }
});

test("acknowledged and unfinished entries do not have reminder cycles", () => {
  for (const patch of [
    { completionAcknowledged: true }, { finishedAt: "invalid" }, { status: "airing" },
    { nextEpisode: 12 }, { languageTracks: [{ code: "de", enabled: true, nextEpisode: 12 }] }
  ]) {
    const entry = { ...completed, ...patch };
    assert.equal(getCompletionNotificationDate(entry, settings), null);
    assert.equal(getCompletionNotificationCycleDate(entry, settings, first.plus({ months: 3 })), null);
  }
});

test("legacy backup restore and restart preserve sent history with open reminders", async (t) => {
  const { store, filePath } = await setup(t);
  const legacy = { ...completed, completionNotifiedAt: first.toISO(), completionNotifiedChannelIds: [channelA] };
  await store.replaceData({ ...store.snapshot(), series: [legacy] });
  const migrated = store.getSeries(completed.id);
  assert.equal(migrated.completionAcknowledged, false);
  assert.equal(migrated.completionAcknowledgedAt, "");
  assert.equal(migrated.completionNotificationCycleAt, "");
  assert.equal(migrated.completionNotifiedAt, first.toISO());
  assert.deepEqual(migrated.completionNotifiedChannelIds, [channelA]);
  assert.equal(getCompletionNotificationDate(migrated, settings), null);
  assert.equal(getFinishedDeletionDate(migrated, settings), null);
  const reopened = createStore(filePath);
  await reopened.init();
  const { updatedAt: restoredUpdatedAt, ...restoredState } = reopened.getSeries(completed.id);
  const { updatedAt: migratedUpdatedAt, ...migratedState } = migrated;
  assert.deepEqual(restoredState, migratedState);
});

test("acknowledgment records one timestamp, survives edits and can be cleared", async (t) => {
  const { store, filePath } = await setup(t);
  const before = DateTime.now();
  let entry = await store.upsertSeries({ ...store.getSeries(completed.id), completionAcknowledged: true });
  assert.equal(entry.completionAcknowledged, true);
  assert.ok(date(entry.completionAcknowledgedAt) >= before);
  assert.ok(date(entry.completionAcknowledgedAt) <= DateTime.now());
  const acknowledgedAt = entry.completionAcknowledgedAt;
  const changes = store.snapshot().changeLog[0].changes.map((change) => change.field);
  assert.ok(changes.includes("completionAcknowledged"));
  assert.ok(changes.includes("completionAcknowledgedAt"));
  entry = await store.upsertSeries({ ...entry, note: "Handled", completionAcknowledgedAt: "" });
  assert.equal(entry.completionAcknowledgedAt, acknowledgedAt);
  const reopened = createStore(filePath);
  await reopened.init();
  entry = await reopened.upsertSeries({ ...reopened.getSeries(completed.id), completionAcknowledged: false });
  assert.equal(entry.completionAcknowledgedAt, "");
  assert.equal(getFinishedDeletionDate(entry, settings), null);
  assert.equal(shouldNotifyCompletion(entry, settings, first), true);
});

test("a delayed dub resets acknowledgment and starts a fresh completion lifecycle", async (t) => {
  const { store } = await setup(t, { completionAcknowledged: true, completionAcknowledgedAt: first.toISO(),
    completionNotifiedAt: first.toISO(), completionNotificationCycleAt: first.toISO(),
    completionNotifiedChannelIds: [channelA] });
  let entry = await store.upsertSeries({ ...store.getSeries(completed.id), enabled: true,
    languageTracks: [{ code: "de", enabled: true, available: true, nextEpisode: 12 }] });
  for (const field of ["finishedAt", "completionAcknowledgedAt", "completionNotifiedAt", "completionNotificationCycleAt"]) {
    assert.equal(entry[field], "");
  }
  assert.equal(entry.completionAcknowledged, false);
  assert.deepEqual(entry.completionNotifiedChannelIds, []);
  entry = await store.upsertSeries({ ...entry, enabled: false, finishedAt: first.toISO(),
    languageTracks: [{ code: "de", enabled: false, available: true, nextEpisode: null }] });
  assert.equal(getCompletionNotificationDate(entry, settings).toISO(), first.plus({ weeks: 1 }).toISO());
});

test("changing the completion date resets an existing lifecycle but restore preserves it", async (t) => {
  const history = { completionAcknowledged: true, completionAcknowledgedAt: first.toISO(),
    completionNotifiedAt: first.toISO(), completionNotificationCycleAt: first.toISO(),
    completionNotifiedChannelIds: [channelA] };
  const { store } = await setup(t, history);
  await store.replaceData(store.snapshot());
  assert.equal(store.getSeries(completed.id).completionAcknowledged, true);
  const entry = await store.upsertSeries({ ...store.getSeries(completed.id), finishedAt: first.toISO() });
  assert.equal(entry.completionAcknowledged, false);
  assert.equal(entry.completionAcknowledgedAt, "");
  assert.equal(entry.completionNotifiedAt, "");
  assert.equal(entry.completionNotificationCycleAt, "");
  assert.deepEqual(entry.completionNotifiedChannelIds, []);
});

test("explicitly clearing delivery state does not resurrect old saved values", async (t) => {
  const { store } = await setup(t, { completionNotifiedAt: first.toISO(),
    completionNotificationCycleAt: first.toISO(), completionNotifiedChannelIds: [channelA] });
  const entry = await store.replaceSeries(completed.id, { ...store.getSeries(completed.id),
    completionNotifiedAt: "", completionNotificationCycleAt: "", completionNotifiedChannelIds: [] });
  assert.equal(entry.completionNotifiedAt, "");
  assert.equal(entry.completionNotificationCycleAt, "");
  assert.deepEqual(entry.completionNotifiedChannelIds, []);
});

test("digest cycles use the latest configured weekly slot and the next slot is strictly later", () => {
  const configured = { ...settings, completionDigestDay: "Friday", completionDigestTime: "9:30" };
  const slot = date("2026-10-09T09:30:00");
  assert.equal(getCompletionDigestCycleDate(configured, slot).toISO(), slot.toISO());
  assert.equal(getNextCompletionDigestDate(configured, slot).toISO(), slot.plus({ weeks: 1 }).toISO());
  assert.equal(getCompletionDigestCycleDate(configured, slot.minus({ milliseconds: 1 })).toISO(),
    slot.minus({ weeks: 1 }).toISO());
  assert.equal(getNextCompletionDigestDate(configured, slot.minus({ milliseconds: 1 })).toISO(), slot.toISO());
  assert.equal(getCompletionDigestCycleDate(configured, slot.plus({ days: 6, hours: 1 })).toISO(), slot.toISO());
  assert.equal(getNextCompletionDigestDate(configured, slot.plus({ days: 6, hours: 1 })).toISO(),
    slot.plus({ weeks: 1 }).toISO());
});

test("digest defaults and invalid inputs fall back to Sunday at 18:00 in Berlin", () => {
  const now = date("2026-10-11T19:00:00");
  for (const configured of [{}, { completionDigestDay: "invalid", completionDigestTime: "25:90" }]) {
    assert.equal(getCompletionDigestCycleDate(configured, now).toISO(), "2026-10-11T18:00:00.000+02:00");
    assert.equal(getNextCompletionDigestDate(configured, now).toISO(), "2026-10-18T18:00:00.000+02:00");
  }
  const invalid = DateTime.invalid("test");
  assert.equal(getCompletionDigestCycleDate(settings, invalid), null);
  assert.equal(getNextCompletionDigestDate(settings, invalid), null);
  assert.equal(getCompletionDigestCycleDate({ timeZone: "No/Such_Zone" }, now), null);
});

test("weekly digest slots retain local Sunday wall time across both DST transitions", () => {
  for (const [before, expected] of [
    ["2026-10-18T18:00:00+02:00", "2026-10-25T18:00:00.000+01:00"],
    ["2026-03-22T18:00:00+01:00", "2026-03-29T18:00:00.000+02:00"]
  ]) {
    const previous = date(before);
    const next = getNextCompletionDigestDate(settings, previous);
    assert.equal(next.toISO(), expected);
    assert.equal(getCompletionDigestCycleDate(settings, next.plus({ minutes: 1 })).toISO(), expected);
    assert.equal(next.diff(previous, "hours").hours, previous.month === 3 ? 167 : 169);
  }
  const utcNow = DateTime.fromISO("2026-10-25T17:30:00Z");
  assert.equal(getCompletionDigestCycleDate(settings, utcNow).toISO(), "2026-10-25T18:00:00.000+01:00");
  assert.equal(getCompletionDigestCycleDate({ ...settings, timeZone: "America/New_York" }, utcNow).toISO(),
    "2026-10-18T18:00:00.000-04:00");
});

test("all configured weekdays are selectable without changing digest wall time", () => {
  const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const now = date("2026-10-11T20:00:00");
  for (const [index, weekday] of weekdays.entries()) {
    const configured = { ...settings, completionDigestDay: weekday, completionDigestTime: "07:45" };
    const latest = getCompletionDigestCycleDate(configured, now);
    const next = getNextCompletionDigestDate(configured, now);
    assert.equal(latest.weekday, index + 1);
    assert.equal(next.weekday, index + 1);
    assert.equal(latest.toFormat("HH:mm"), "07:45");
    assert.equal(next.toFormat("HH:mm"), "07:45");
    assert.ok(latest <= now);
    assert.ok(next > now);
    assert.equal(next.diff(latest, "weeks").weeks, 1);
  }
});

test("digest settings have defaults and survive partial settings edits, backup restore and restart", async (t) => {
  const { store, filePath } = await setup(t);
  assert.equal(store.getSettings().completionDigestDay, "sunday");
  assert.equal(store.getSettings().completionDigestTime, "18:00");
  await store.updateSettings({ ...store.getSettings(), completionDigestDay: "Friday", completionDigestTime: "9:30" });
  assert.equal(store.getSettings().completionDigestDay, "friday");
  assert.equal(store.getSettings().completionDigestTime, "09:30");
  await store.updateSettings({ summaryLimit: 7, completionDigestDay: "wrong", completionDigestTime: "27:00" });
  assert.equal(store.getSettings().completionDigestDay, "friday");
  assert.equal(store.getSettings().completionDigestTime, "09:30");
  const backup = store.snapshot();
  await store.replaceData(backup);
  const reopened = createStore(filePath);
  await reopened.init();
  assert.equal(reopened.getSettings().completionDigestDay, "friday");
  assert.equal(reopened.getSettings().completionDigestTime, "09:30");
  assert.equal(reopened.getSettings().summaryLimit, 7);
});

test("legacy and malformed backups normalize digest settings and global receipts", async (t) => {
  const { store } = await setup(t);
  for (const completionDigest of [undefined, null, [], "bad", { cycleAt: "bad", completedAt: "bad", sentChannelIds: ["bad"] }]) {
    await store.replaceData({ settings: { completionDigestDay: "wrong", completionDigestTime: "25:90" },
      series: [completed], completionDigest });
    assert.equal(store.getSettings().completionDigestDay, "sunday");
    assert.equal(store.getSettings().completionDigestTime, "18:00");
    assert.deepEqual(store.getCompletionDigest(), { cycleAt: "", sentChannelIds: [], completedAt: "" });
  }
});

test("partial digest delivery receipts survive backup and restart without modifying series state", async (t) => {
  const { store, filePath } = await setup(t);
  const before = store.snapshot();
  const cycleAt = date("2026-10-11T18:00:00").toISO();
  await store.updateCompletionDigest({ cycleAt, sentChannelIds: [channelA, channelA, "bad", ` ${channelB} `] });
  const expected = { cycleAt, sentChannelIds: [channelA, channelB], completedAt: "" };
  assert.deepEqual(store.getCompletionDigest(), expected);
  assert.deepEqual(store.snapshot().series, before.series);
  assert.deepEqual(store.snapshot().settings, before.settings);
  assert.deepEqual(store.snapshot().posts, before.posts);
  assert.deepEqual(store.snapshot().changeLog, before.changeLog);
  const copy = store.getCompletionDigest();
  copy.sentChannelIds.push("333333333333333333");
  copy.cycleAt = "changed";
  assert.deepEqual(store.getCompletionDigest(), expected);
  await store.replaceData(store.snapshot());
  const reopened = createStore(filePath);
  await reopened.init();
  assert.deepEqual(reopened.getCompletionDigest(), expected);
});

test("a digest round can be completed, partially updated and explicitly cleared", async (t) => {
  const { store } = await setup(t);
  const cycleAt = date("2026-10-11T18:00:00").toISO();
  const completedAt = date("2026-10-11T18:01:00").toISO();
  await store.updateCompletionDigest({ cycleAt, sentChannelIds: [channelA] });
  await store.updateCompletionDigest({ completedAt });
  assert.deepEqual(store.getCompletionDigest(), { cycleAt, sentChannelIds: [channelA], completedAt });
  await store.updateCompletionDigest({ cycleAt: undefined, sentChannelIds: null, completedAt: undefined });
  assert.deepEqual(store.getCompletionDigest(), { cycleAt, sentChannelIds: [channelA], completedAt });
  await store.updateCompletionDigest({ cycleAt: "", sentChannelIds: [], completedAt: "" });
  assert.deepEqual(store.getCompletionDigest(), { cycleAt: "", sentChannelIds: [], completedAt: "" });
});
