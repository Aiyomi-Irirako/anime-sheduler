import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { load } from "cheerio";
import { createStore } from "../src/store.js";
import { createWebApp } from "../src/web.js";
import { getFinishedDeletionDate } from "../src/schedule.js";

const completedSeries = {
  title: "Completed reminder example",
  status: "finished",
  enabled: false,
  nextEpisode: null,
  episodeCount: 12,
  languageTracks: [],
  finishedAt: "2026-10-01T17:00:00+02:00",
  scheduleLink: "https://www.livechart.me/anime/11218/schedules",
  service: "Amazon Prime Video",
  streamingServiceId: "KEEP-SERVICE-ID",
  tvdbId: "123456",
  note: "Keep this note",
  completionNotifiedAt: "2026-10-08T17:00:00+02:00",
  completionNotifiedChannelIds: ["111111111111111111"]
};

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anime-completion-reminder-web-"));
  const store = createStore(path.join(directory, "isolated-db.json"));
  await store.init();
  await store.updateSettings({ ...store.getSettings(), timeZone: "Europe/Berlin" });
  const posts = [];
  const syncs = [];
  const app = createWebApp(store, {
    enabled: false,
    async listTextChannels() { return []; },
    async listMentionRoles() { return []; },
    async post(...args) { posts.push(args); }
  }, process.cwd(), {
    discovery: { status: () => ({ running: false }) },
    liveChartSync: {
      status: () => ({ running: false }),
      start(options) { syncs.push(structuredClone(options)); }
    },
    fetchTitle: async () => { throw new Error("Unexpected LiveChart request"); },
    fetchSeriesDraft: async () => { throw new Error("Unexpected LiveChart request"); }
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = () => process.env.WEB_PASSWORD
    ? { Authorization: `Basic ${Buffer.from(`${process.env.WEB_USER || "admin"}:${process.env.WEB_PASSWORD}`).toString("base64")}` }
    : {};
  const get = (route) => fetch(base + route, { headers: headers() });
  const post = (route, body = new URLSearchParams()) => fetch(base + route, {
    method: "POST", redirect: "manual", headers: headers(), body
  });
  return { store, get, post, posts, syncs };
}

function editorForm(html, selector = "#series-form") {
  const $ = load(html);
  const body = new URLSearchParams();
  $(`${selector} input, ${selector} select, ${selector} textarea`).each((_, element) => {
    const input = $(element);
    const name = input.attr("name");
    if (!name || input.attr("disabled") !== undefined) return;
    if (input.attr("type") === "checkbox" && !input.is(":checked")) return;
    body.append(name, input.attr("type") === "checkbox" ? "on" : input.val() || "");
  });
  return body;
}

function withoutAcknowledgementAndEditTime(series) {
  const { completionAcknowledged, completionAcknowledgedAt, updatedAt, ...rest } = series;
  return rest;
}

test("completed editors expose the handled checkbox and presence marker, including its saved state", async (t) => {
  const { store, get } = await setup(t);
  const series = await store.upsertSeries(completedSeries);
  const $ = load(await (await get(`/series/${series.id}`)).text());
  const checkbox = $('#series-form input[name="completionAcknowledged"]');
  assert.equal(checkbox.attr("type"), "checkbox");
  assert.equal(checkbox.is(":checked"), false);
  assert.match(checkbox.closest("label").text(), /Completion handled/);
  assert.equal($('#series-form input[name="completionAcknowledgementPresent"]').attr("type"), "hidden");
  assert.equal($('#series-form input[name="completionAcknowledgementPresent"]').val(), "1");

  await store.upsertSeries({ ...series, completionAcknowledged: true });
  const handled = load(await (await get(`/series/${series.id}`)).text());
  assert.equal(handled('#series-form input[name="completionAcknowledged"]').is(":checked"), true);
});

test("pending main releases and enabled dub releases have no completion checkbox", async (t) => {
  const { store, get } = await setup(t);
  for (const patch of [
    { title: "Main still airing", status: "airing", enabled: true, nextEpisode: 12 },
    { title: "Dub still airing", languageTracks: [{ code: "de", enabled: true, nextEpisode: 12 }] }
  ]) {
    const series = await store.upsertSeries({ ...completedSeries, scheduleLink: "", ...patch });
    const $ = load(await (await get(`/series/${series.id}`)).text());
    assert.equal($('#series-form input[name="completionAcknowledged"]').length, 0);
    assert.equal($('#series-form input[name="completionAcknowledgementPresent"]').length, 0);
  }
});

test("Completion separates open and handled confirmations while Finished remains an archive", async (t) => {
  const { store, get, posts } = await setup(t);
  const open = await store.upsertSeries({ ...completedSeries, title: "Awaiting handling", scheduleLink: "" });
  const waiting = await store.upsertSeries({ ...completedSeries, title: "Awaiting first notice", scheduleLink: "", completionNotifiedAt: "" });
  const handled = await store.upsertSeries({ ...completedSeries, title: "Already handled", scheduleLink: "", completionAcknowledged: true });
  await store.upsertSeries({ ...completedSeries, title: "Not completed", scheduleLink: "", status: "airing", enabled: true, nextEpisode: 1 });
  const $ = load(await (await get("/completion")).text());
  assert.equal($("h1").text(), "Completion");
  assert.equal($('nav.nav-links a[href="/completion"]').text(), "Completion");
  assert.match($('nav[aria-label="Completion views"]').text(), /Open \(2\).*Handled \(1\)/s);
  const openRow = $(`a[href="/series/${open.id}"]`).first().closest("tr");
  const waitingRow = $(`a[href="/series/${waiting.id}"]`).first().closest("tr");
  assert.match(openRow.text(), /Included in the weekly digest/);
  assert.match(waitingRow.text(), /First notice:.*after this notice is sent/s);
  assert.equal($(`a[href="/series/${handled.id}"]`).length, 0);
  assert.doesNotMatch($("tbody").text(), /Not completed/);
  assert.equal(getFinishedDeletionDate(store.getSeries(open.id), store.getSettings()), null);

  const handledPage = load(await (await get("/completion?view=handled")).text());
  const handledRow = handledPage(`a[href="/series/${handled.id}"]`).first().closest("tr");
  assert.match(handledRow.text(), /Handled/);
  assert.match(handledRow.text(), /Reminders stopped/);
  assert.equal(handledPage(`a[href="/series/${open.id}"]`).length, 0);
  for (const [series, row, checked] of [[open, openRow, false], [waiting, waitingRow, false], [handled, handledRow, true]]) {
    const form = row.find(`form[action="/series/${series.id}/completion"]`);
    assert.equal(form.attr("method"), "post");
    assert.equal(form.find('input[name="completionAcknowledged"]').attr("type"), "checkbox");
    assert.equal(form.find('input[name="completionAcknowledged"]').is(":checked"), checked);
    assert.equal(form.find('input[name="returnTo"]').val(), checked ? "/completion?view=handled" : "/completion");
    assert.match(form.find('button[type="submit"]').text(), /Save/);
  }

  const archive = load(await (await get("/finished")).text());
  assert.equal(archive('input[name="completionAcknowledged"]').length, 0);
  assert.ok(archive('a[href="/completion"]').length > 0);
  const archivedOpen = archive(`a[href="/series/${open.id}"]`).first().closest("tr");
  const archivedHandled = archive(`a[href="/series/${handled.id}"]`).first().closest("tr");
  assert.match(archivedOpen.text(), /Awaiting confirmation/);
  const cleanup = getFinishedDeletionDate(store.getSeries(handled.id), store.getSettings());
  assert.ok(cleanup?.isValid);
  assert.ok(archivedHandled.text().includes(cleanup.setLocale("en").toFormat("dd LLL yyyy HH:mm")));
  assert.equal(posts.length, 0);
});

test("the Completion acknowledgement action changes only acknowledgement fields and can resume reminders", async (t) => {
  const { store, post, posts } = await setup(t);
  const series = await store.upsertSeries(completedSeries);
  const body = new URLSearchParams({
    completionAcknowledged: "on", title: "Must not overwrite", status: "airing",
    nextEpisode: "1", service: "Must not overwrite", note: "Must not overwrite", tvdbId: "999999"
  });
  const response = await post(`/series/${series.id}/completion`, body);
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location"), /^\/completion(?:\?|$)/);
  const acknowledged = store.getSeries(series.id);
  assert.equal(acknowledged.completionAcknowledged, true);
  assert.ok(Number.isFinite(Date.parse(acknowledged.completionAcknowledgedAt)));
  assert.deepEqual(withoutAcknowledgementAndEditTime(acknowledged), withoutAcknowledgementAndEditTime(series));

  await post(`/series/${series.id}/completion`, new URLSearchParams({ completionAcknowledged: "on" }));
  assert.equal(store.getSeries(series.id).completionAcknowledgedAt, acknowledged.completionAcknowledgedAt);
  await post(`/series/${series.id}/completion`);
  const reopened = store.getSeries(series.id);
  assert.equal(reopened.completionAcknowledged, false);
  assert.equal(reopened.completionAcknowledgedAt, "");
  assert.deepEqual(withoutAcknowledgementAndEditTime(reopened), withoutAcknowledgementAndEditTime(series));
  assert.equal(posts.length, 0);
});

test("the Completion action accepts only an on checkbox and rejects unfinished or missing entries", async (t) => {
  const { store, post } = await setup(t);
  const completed = await store.upsertSeries({ ...completedSeries, completionAcknowledged: true });
  for (const value of ["true", "1", "off"]) {
    await store.upsertSeries({ ...store.getSeries(completed.id), completionAcknowledged: true });
    await post(`/series/${completed.id}/completion`, new URLSearchParams({ completionAcknowledged: value }));
    assert.equal(store.getSeries(completed.id).completionAcknowledged, false, value);
  }
  const pending = await store.upsertSeries({ ...completedSeries, title: "Pending release", scheduleLink: "",
    status: "airing", enabled: true, nextEpisode: 1 });
  const before = store.snapshot();
  for (const id of [pending.id, "absent-series"]) {
    const rejected = await post(`/series/${id}/completion`, new URLSearchParams({ completionAcknowledged: "on" }));
    assert.ok(rejected.status >= 400 || /[?&]error=/.test(rejected.headers.get("location") || ""));
  }
  assert.deepEqual(store.snapshot(), before);
});

test("Completion redirects keep only the allowed handled view and reject external return targets", async (t) => {
  const { store, post } = await setup(t);
  const series = await store.upsertSeries(completedSeries);
  const handled = await post(`/series/${series.id}/completion`, new URLSearchParams({
    completionAcknowledged: "on", returnTo: "/completion?view=handled"
  }));
  assert.match(handled.headers.get("location"), /^\/completion\?view=handled&ok=/);
  for (const returnTo of ["https://example.invalid/", "//example.invalid/", "/settings", "/completion?view=handled&external=1"]) {
    const response = await post(`/series/${series.id}/completion`, new URLSearchParams({ returnTo }));
    assert.match(response.headers.get("location"), /^\/completion\?ok=/);
  }
});

test("Settings saves any weekday and time for the weekly digest and Completion shows the configuration", async (t) => {
  const { store, get, post, posts } = await setup(t);
  const settingsHtml = await (await get("/settings")).text();
  const $ = load(settingsHtml);
  const day = $('#settings-schedule select[name="completionDigestDay"]');
  assert.deepEqual(day.find("option").map((_, element) => $(element).val()).get(), [
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"
  ]);
  assert.equal(day.val(), "sunday");
  const time = $('#settings-schedule input[name="completionDigestTime"]');
  assert.equal(time.attr("type"), "time");
  assert.equal(time.val(), "18:00");
  const body = editorForm(settingsHtml, ".settings-form");
  body.set("completionDigestDay", "wednesday");
  body.set("completionDigestTime", "07:15");
  body.set("timeZone", "Asia/Tokyo");
  const response = await post("/settings", body);
  assert.equal(response.status, 302);
  assert.equal(store.getSettings().completionDigestDay, "wednesday");
  assert.equal(store.getSettings().completionDigestTime, "07:15");
  const savedSettings = load(await (await get("/settings")).text());
  assert.equal(savedSettings('select[name="completionDigestDay"]').val(), "wednesday");
  assert.equal(savedSettings('input[name="completionDigestTime"]').val(), "07:15");
  const completion = load(await (await get("/completion")).text());
  assert.match(completion("main").text(), /Every Wednesday at 07:15 \(Asia\/Tokyo\)\. Next: \d{2} \w{3} \d{4} 07:15/);
  assert.equal(completion('a[href="/settings#settings-schedule"]').text(), "Change in Settings");
  assert.equal(posts.length, 0);
});

test("Completion empty states remain usable in both views", async (t) => {
  const { get } = await setup(t);
  const open = load(await (await get("/completion")).text());
  const handled = load(await (await get("/completion?view=handled")).text());
  assert.match(open("tbody").text(), /No open completions/);
  assert.match(handled("tbody").text(), /No handled completions/);
  assert.equal(open('a[aria-current="page"]').attr("href"), "/completion");
  assert.equal(handled('a[aria-current="page"]').attr("href"), "/completion?view=handled");
});

test("Save and Test post preserve acknowledgement for old forms and apply explicit checkbox changes", async (t) => {
  const { store, get, post, posts } = await setup(t);
  const series = await store.upsertSeries({ ...completedSeries, completionAcknowledged: true });
  for (const suffix of ["", "/test-post"]) {
    await store.upsertSeries({ ...store.getSeries(series.id), completionAcknowledged: true });
    const previousAt = store.getSeries(series.id).completionAcknowledgedAt;
    const legacy = editorForm(await (await get(`/series/${series.id}`)).text());
    legacy.delete("completionAcknowledgementPresent");
    legacy.delete("completionAcknowledged");
    await post(`/series/${series.id}${suffix}`, legacy);
    assert.equal(store.getSeries(series.id).completionAcknowledged, true, `${suffix || "save"}: legacy form`);
    assert.equal(store.getSeries(series.id).completionAcknowledgedAt, previousAt);

    legacy.set("completionAcknowledgementPresent", "1");
    await post(`/series/${series.id}${suffix}`, legacy);
    assert.equal(store.getSeries(series.id).completionAcknowledged, false, `${suffix || "save"}: unchecked`);
    assert.equal(store.getSeries(series.id).completionAcknowledgedAt, "");

    legacy.set("completionAcknowledged", "on");
    await post(`/series/${series.id}${suffix}`, legacy);
    assert.equal(store.getSeries(series.id).completionAcknowledged, true, `${suffix || "save"}: checked`);
    assert.ok(store.getSeries(series.id).completionAcknowledgedAt);
  }
  // Completed entries have no upcoming release; Test post still saves the form.
  assert.equal(posts.length, 0);
});

test("Sync form patches preserve legacy acknowledgement and honor explicitly checked or unchecked values", async (t) => {
  const { store, get, post, syncs } = await setup(t);
  const series = await store.upsertSeries({ ...completedSeries, completionAcknowledged: true });
  const body = editorForm(await (await get(`/series/${series.id}`)).text());
  body.delete("completionAcknowledgementPresent");
  body.delete("completionAcknowledged");
  await post(`/series/${series.id}/sync-livechart`, body);
  assert.equal(syncs.at(-1).patch.completionAcknowledged, true);
  assert.equal(syncs.at(-1).patch.completionAcknowledgedAt, series.completionAcknowledgedAt);

  body.set("completionAcknowledgementPresent", "1");
  await post(`/series/${series.id}/sync-livechart`, body);
  assert.equal(syncs.at(-1).patch.completionAcknowledged, false);

  body.set("completionAcknowledged", "on");
  await post(`/series/${series.id}/sync-livechart`, body);
  assert.equal(syncs.at(-1).patch.completionAcknowledged, true);
  assert.equal(syncs.length, 3);
});
