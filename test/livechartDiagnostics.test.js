import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { load } from "cheerio";
import { DateTime } from "luxon";
import { parseLiveChartEpisodes } from "../src/livechart.js";
import { syncOneSeriesFromLiveChart } from "../src/livechartSync.js";
import { createStore } from "../src/store.js";
import { createWebApp } from "../src/web.js";

const now = DateTime.fromISO("2026-11-19T15:45:00+01:00", { setZone: true });
const link = "https://www.livechart.me/anime/123/schedules";

const schedule = ({ dub = false, provider, episode = "EP 5", date = "2026-11-24", precision = 3 }) => `
  <article data-controller="release-schedule">
    <div><time data-label="${episode}" data-intl-time-datetime="${date}" data-intl-time-precision="${precision}">${episode}</time></div>
    <div title="Simulcast: ${dub ? "Dubbed" : "Subbed"}"></div>
    <span class="lc-text-contextual-accent">${provider}</span>
    <span data-release-schedule-info-target="${dub ? "auralTracklist" : "textualTracklist"}"
      data-tracklist-data='${dub ? '{"de":[]}' : '{"en":[]}'}'></span>
  </article>`;

async function setup(t, series = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anime-livechart-diagnosis-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, "isolated-db.json"));
  await store.init();
  await store.updateSettings({
    ...store.getSettings(), timeZone: "Europe/Berlin", preferredScheduleLanguage: "de", enabledLanguageCodes: ["de"]
  });
  await store.upsertSeries({
    id: "example", title: "Fixture", scheduleLink: link, liveChartLanguageStrict: true, ...series
  });
  return store;
}

test("a no-change check persists its subtitle and dub diagnoses, and an HTTP failure leaves the last success visible", async (t) => {
  const store = await setup(t);
  const current = () => store.getSeries("example");
  const html = schedule({ provider: "Crunchyroll" }) + schedule({ dub: true, provider: "ADN" });
  const sync = (at, fetchEpisodes) => syncOneSeriesFromLiveChart(store, current(), {
    now: at, overwriteSchedule: true, fetchEpisodes
  });
  const parse = async (_, options) => ({ ...parseLiveChartEpisodes(html, options), imageUrl: "" });
  await sync(now, parse);
  const before = store.snapshot();

  const successAt = now.plus({ minutes: 1 });
  const result = await sync(successAt, parse);
  assert.equal(result.changed, false);
  assert.deepEqual(store.snapshot().series, before.series);
  assert.deepEqual(store.snapshot().changeLog, before.changeLog);
  assert.equal(store.getLiveChartCheck(current()).successfulAt, successAt.toISO());

  const failureAt = now.plus({ minutes: 2 });
  await assert.rejects(sync(failureAt, async () => {
    throw Object.assign(new Error("LiveChart responded with HTTP 429."), { status: 429 });
  }), /HTTP 429/);
  assert.deepEqual(store.snapshot().series, before.series);

  const restored = createStore(store.filePath);
  await restored.init();
  const check = restored.getLiveChartCheck(restored.getSeries("example"));
  assert.equal(check.successfulAt, successAt.toISO());
  assert.equal(check.attemptedAt, failureAt.toISO());

  const app = createWebApp(restored, { enabled: false, async post() { assert.fail("Unexpected Discord post"); } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => server.once("listening", resolve).once("error", reject));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/series/example`;
  const headers = process.env.WEB_PASSWORD ? { Authorization: `Basic ${Buffer.from(
    `${process.env.WEB_USER || "admin"}:${process.env.WEB_PASSWORD}`
  ).toString("base64")}` } : {};
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  const $ = load(await response.text());
  const diagnosis = $(".livechart-diagnosis");
  assert.match(diagnosis.text(), /Last successful check on 19 Nov 2026 15:46/);
  assert.match(diagnosis.text(), /Check failed on 19 Nov 2026 15:47.*HTTP 429/);
  assert.match(diagnosis.text(), /no schedule with German subtitles/);
  assert.match(diagnosis.text(), /German dub \(ADN\).*has not specified a time/);
  assert.doesNotMatch(diagnosis.text(), /Crunchyroll/);

  await restored.upsertSeries({ ...restored.getSeries("example"), scheduleLink: link.replace("/123/", "/456/") });
  assert.equal(restored.getLiveChartCheck(restored.getSeries("example")), null);
});

test("known episode without an exact date differs from a release with no episode number", async (t) => {
  const store = await setup(t, { liveChartLanguageStrict: false });
  const current = () => store.getSeries("example");
  const sync = (html) => syncOneSeriesFromLiveChart(store, current(), {
    now, overwriteSchedule: true, fetchEpisodes: async (_, options) => parseLiveChartEpisodes(html, options)
  });
  await sync(schedule({ provider: "Crunchyroll", date: "2026-11-01", precision: 2 }));
  assert.equal(store.getLiveChartCheck(current()).releases[0].status, "date-unknown");
  await sync(schedule({ provider: "Crunchyroll", episode: "Upcoming" }));
  assert.equal(store.getLiveChartCheck(current()).releases[0].status, "episode-unknown");
});
