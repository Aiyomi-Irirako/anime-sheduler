import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { load } from "cheerio";
import { createStore } from "../src/store.js";
import { createWebApp } from "../src/web.js";

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anime-sheduler-tvdb-id-"));
  const filePath = path.join(directory, "db.json");
  const store = createStore(filePath);
  await store.init();
  const posts = [];
  const discord = { enabled: true, ready: true, async post(message) { posts.push(message); } };
  const server = createWebApp(store, discord).listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = process.env.WEB_PASSWORD
    ? { Authorization: `Basic ${Buffer.from(`${process.env.WEB_USER || "admin"}:${process.env.WEB_PASSWORD}`).toString("base64")}` }
    : {};
  return {
    store, posts, filePath,
    get: (route) => fetch(baseUrl + route, { headers }),
    post: (route, body) => fetch(baseUrl + route, { method: "POST", headers, redirect: "manual", body })
  };
}

function formData(html) {
  const $ = load(html);
  const body = new URLSearchParams();
  $("#series-form input, #series-form select, #series-form textarea").each((_, element) => {
    const input = $(element);
    const name = input.attr("name");
    if (!name || (input.attr("type") === "checkbox" && !input.is(":checked"))) return;
    body.append(name, input.attr("type") === "checkbox" ? "on" : input.val() || "");
  });
  return body;
}

test("web forms create, edit and clear TVDB IDs, and test posts use the saved ID", async (t) => {
  const { store, posts, filePath, get, post } = await setup(t);
  const freshPage = await get("/series/new");
  assert.equal(freshPage.status, 200);
  const freshHtml = await freshPage.text();
  assert.equal(load(freshHtml)('input[name="tvdbId"]').length, 1);
  const body = formData(freshHtml);
  for (const [name, value] of Object.entries({
    title: "TVDB Form Series", service: "Crunchyroll", tvdbId: "  001234  ",
    scheduleMode: "manual", nextEpisode: "1", nextDate: "2099-10-22", releaseTime: "18:00"
  })) body.set(name, value);
  assert.equal((await post("/series", body)).status, 302);
  const [created] = store.listSeries();
  assert.equal(created.tvdbId, "001234");
  assert.equal(posts.length, 0);

  const route = `/series/${encodeURIComponent(created.id)}`;
  const editHtml = await (await get(route)).text();
  assert.equal(load(editHtml)('input[name="tvdbId"]').val(), "001234");
  const edit = formData(editHtml);
  edit.set("tvdbId", "987654");
  assert.equal((await post(route, edit)).status, 302);
  assert.equal(store.getSeries(created.id).tvdbId, "987654");
  const reloaded = createStore(filePath);
  await reloaded.init();
  assert.equal(reloaded.getSeries(created.id).tvdbId, "987654");

  assert.equal((await post(`${route}/test-post`, edit)).status, 302);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].embeds[0].toJSON().fields.find((field) => field.name === "TVDB ID"), {
    name: "TVDB ID", value: "```text\n987654\n```", inline: false
  });

  edit.set("tvdbId", "");
  assert.equal((await post(`${route}/test-post`, edit)).status, 302);
  assert.equal(store.getSeries(created.id).tvdbId, "");
  assert.equal(posts.length, 2);
  assert.equal(posts[1].embeds[0].toJSON().fields.some((field) => field.name === "TVDB ID"), false);
});

test("legacy form submissions and CSV updates preserve an imported TVDB ID", async (t) => {
  const { store, posts, filePath, get, post } = await setup(t);
  assert.deepEqual(await store.importCsv([
    "title,service,schedulelink,rldate,nextep,tvdb_id",
    "CSV TVDB Series,Crunchyroll,https://www.livechart.me/anime/12345/schedules,Monday @ 18:00,1,444123"
  ].join("\n")), { total: 1, created: 1, updated: 0, skipped: 0 });
  const [series] = store.listSeries();
  assert.equal(series.tvdbId, "444123");
  const route = `/series/${encodeURIComponent(series.id)}`;
  const body = formData(await (await get(route)).text());
  body.delete("tvdbId");
  assert.equal((await post(route, body)).status, 302);
  assert.equal(store.getSeries(series.id).tvdbId, "444123");
  assert.equal((await post(`${route}/test-post`, body)).status, 302);
  assert.equal(store.getSeries(series.id).tvdbId, "444123");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].embeds[0].toJSON().fields.find((field) => field.name === "TVDB ID").value,
    "```text\n444123\n```");

  await store.importCsv([
    "title,service,schedulelink,rldate,nextep",
    "CSV TVDB Series,Crunchyroll,https://www.livechart.me/anime/12345/schedules,Monday @ 18:00,2"
  ].join("\n"), { updateExisting: true, overwriteSchedule: true });
  const reloaded = createStore(filePath);
  await reloaded.init();
  assert.equal(reloaded.getSeries(series.id).tvdbId, "444123");
});

test("a German dub-only test post includes the TVDB ID without requiring a service ID", async (t) => {
  const { store, posts, get, post } = await setup(t);
  const series = await store.upsertSeries({
    title: "German Dub TVDB Series", service: "Animation Digital Network", tvdbId: "333123",
    streamingServiceId: "", scheduleMode: "manual", nextEpisode: null,
    languageTracks: [{ code: "de", enabled: true, nextEpisode: 1, nextDate: "2099-10-22",
      releaseTime: "18:00", weekly: false }]
  });
  const route = `/series/${encodeURIComponent(series.id)}`;
  const body = formData(await (await get(route)).text());
  assert.equal((await post(`${route}/test-post`, body)).status, 302);
  assert.equal(posts.length, 1);
  const fields = posts[0].embeds[0].toJSON().fields;
  assert.equal(fields.find((field) => field.name.startsWith("Version")).value, "German");
  assert.equal(fields.find((field) => field.name === "TVDB ID").value, "```text\n333123\n```");
  assert.equal(fields.some((field) => field.name === "Service ID"), false);
  assert.deepEqual(posts[0].allowedMentions, { parse: [] });
});
