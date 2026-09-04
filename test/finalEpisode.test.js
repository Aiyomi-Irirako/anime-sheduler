import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { createStore } from "../src/store.js";
import { parseLiveChartEpisodes } from "../src/livechart.js";
import { syncAllLiveChart, syncOneSeriesFromLiveChart } from "../src/livechartSync.js";
import { checkDueAnnouncements } from "../src/scheduler.js";
import { getFinishedDeletionDate, isSeriesComplete, shouldDeleteFinishedSeries } from "../src/schedule.js";

const now = DateTime.fromISO("2026-09-01T17:01:00", { zone: "Europe/Berlin" });
const releasedHtml = `<article>
  <a title="Simulcast: Subbed">Simulcast: Subbed</a>
  <div data-tracklist-json="{&quot;ja&quot;:[&quot;JA&quot;],&quot;de&quot;:[&quot;DE&quot;]}"></div>
  <span>Released</span><span>Crunchyroll</span>
</article>`;

async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anime-sheduler-finale-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, "db.json"));
  await store.init();
  await store.updateSettings({ ...store.getSettings(), preferredScheduleLanguage: "de", enabledLanguageCodes: [] });
  const series = await store.upsertSeries({
    id: "victoria",
    title: "Victoria of Many Faces",
    service: "Crunchyroll",
    scheduleLink: "https://www.livechart.me/anime/13315/schedules",
    nextEpisode: 9,
    episodeCount: 9,
    nextDate: "2026-09-01",
    releaseTime: "17:00",
    status: "airing",
    enabled: true,
    languageTracks: [],
    lastPostedKey: "victoria:main:8:release-time:2026-08-25T17:00:00.000+02:00",
    lastPostedAt: "2026-08-25T17:00:05+02:00",
    ...overrides
  });
  // Exercise the real parser and sync without making LiveChart requests or Discord posts.
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    assert.ok(url === series.scheduleLink || url === "https://www.livechart.me/anime/13315");
    return new Response(url.endsWith("/schedules") ? releasedHtml : "<div>Episodes 9</div>", { status: 200 });
  });
  const messages = [];
  const discord = { enabled: true, ready: true, async post(message) { messages.push(message); } };
  return { store, series, messages, discord };
}

test("posts episode 9 exactly once when the preferred service switches to Released", async (t) => {
  const { store, messages, discord } = await setup(t);
  const live = parseLiveChartEpisodes(releasedHtml, { preferredLanguageCodes: ["de"], nowTimestamp: now.toSeconds() });
  assert.equal(live.preferredReleaseFinished, true);

  const result = await checkDueAnnouncements(store, discord, { now });
  assert.equal(result.posted, 1);
  assert.equal(store.snapshot().posts[0].episode, 9);
  assert.match(messages[0].embeds[0].data.title, /Episode 09/);
  assert.ok(isSeriesComplete(store.getSeries("victoria")));
  assert.equal((await checkDueAnnouncements(store, discord, { now: now.plus({ minutes: 1 }) })).posted, 0);
  assert.equal(messages.length, 1);
});

test("a daily sync retains a due finale until posting succeeds", async (t) => {
  const { store, messages, discord } = await setup(t);
  await syncAllLiveChart(store, { now, delayMs: 0 });
  assert.equal(store.getSeries("victoria").nextEpisode, 9);
  assert.equal(store.getSeries("victoria").enabled, true);
  assert.equal(store.getSeries("victoria").nextDate, "2026-09-01");
  await assert.rejects(checkDueAnnouncements(store, {
    ...discord,
    async post() { throw new Error("Discord unavailable"); }
  }, { now }), /Discord unavailable/);
  assert.equal(store.getSeries("victoria").nextEpisode, 9);
  assert.equal((await checkDueAnnouncements(store, discord, { now: now.plus({ minutes: 1 }) })).posted, 1);
  assert.equal(messages.length, 1);
});

test("keeps newly finished entries with old episode totals through daily cleanup", async (t) => {
  const { store, series } = await setup(t, {
    enabled: false, status: "finished", nextEpisode: null, finishedAt: "2026-09-01T17:00:00+02:00"
  });
  await store.upsertSeries({ ...series, episodeCountUpdatedAt: "2026-07-01T12:00:00+02:00" });
  const result = await syncAllLiveChart(store, { now: now.plus({ days: 3 }), delayMs: 0 });
  assert.equal(result.deleted, 0);
  assert.ok(isSeriesComplete(store.getSeries(series.id)));
  assert.equal(getFinishedDeletionDate(store.getSeries(series.id)).toISODate(), "2026-10-01");
  assert.equal(shouldDeleteFinishedSeries(store.getSeries(series.id), {}, now.plus({ months: 1 })), true);
});

for (const [label, overrides, syncAt] of [
  ["already posted finale", { lastPostedKey: "victoria:main:9:release-time:2026-09-01T17:00:00.000+02:00" }, now],
  ["expired finale", {}, now.plus({ hours: 7 })],
  ["old broadcast episode after a batch release", { nextEpisode: 3 }, now],
  ["a reminder before the scheduled finale", {}, now.minus({ minutes: 30 })]
]) {
  test(`does not preserve ${label} when the service is Released`, async (t) => {
    const { store, series, messages, discord } = await setup(t, overrides);
    await syncOneSeriesFromLiveChart(store, series, { overwriteSchedule: true, now: syncAt });
    assert.equal(store.getSeries(series.id).nextEpisode, null);
    assert.equal(store.getSeries(series.id).enabled, false);
    assert.equal((await checkDueAnnouncements(store, discord, { now: syncAt })).posted, 0);
    assert.equal(messages.length, 0);
  });
}

test("retains a final batch and a finale with missing time", async (t) => {
  const { store, series, messages, discord } = await setup(t, {
    nextEpisode: 8, episodeBatchSize: 2, releaseTime: "",
    lastPostedKey: "victoria:main:7:release-time:2026-08-25T17:00:00.000+02:00"
  });
  const fallbackNow = now.set({ hour: 18 });
  assert.equal((await checkDueAnnouncements(store, discord, { now: fallbackNow })).posted, 1);
  assert.match(messages[0].embeds[0].data.title, /Episode 08-09/);
  // A stale reload must not repeat a missing-time finale whose key has no episode number.
  await store.upsertSeries({ ...series, lastPostedKey: store.getSeries(series.id).lastPostedKey,
    lastPostedAt: fallbackNow.toISO() });
  assert.equal((await checkDueAnnouncements(store, discord, { now: fallbackNow.plus({ minutes: 1 }) })).posted, 0);
});

test("retention starts after completion, including delayed dubs and unknown totals", () => {
  const series = { status: "finished", nextEpisode: null, languageTracks: [], episodeCount: 9,
    episodeCountUpdatedAt: "2026-07-01T12:00:00+02:00", finishedAt: "2026-09-01T17:00:00+02:00" };
  assert.equal(shouldDeleteFinishedSeries(series, {}, now.plus({ days: 29 })), false);
  assert.equal(shouldDeleteFinishedSeries(series, {}, now.plus({ months: 1 })), true);
  assert.equal(getFinishedDeletionDate({ ...series, episodeCount: null }).toISODate(), "2026-10-01");
  assert.equal(getFinishedDeletionDate({ ...series, episodeCountUpdatedAt: "2026-09-10T12:00:00+02:00" }).toISODate(), "2026-10-10");
  assert.equal(getFinishedDeletionDate({ ...series, languageTracks: [{ code: "de", enabled: true, nextEpisode: 8 }] }), null);
  assert.equal(getFinishedDeletionDate({ ...series, finishedAt: "" }), null);
});
