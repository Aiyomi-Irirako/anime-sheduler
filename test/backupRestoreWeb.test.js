import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { load } from "cheerio";
import { createStore } from "../src/store.js";
import { createWebApp } from "../src/web.js";

const currentChannel = "111111111111111111";
const incomingChannel = "222222222222222222";
const incomingRole = "333333333333333333";
const incoming = {
  settings: {
    discordChannelIds: [incomingChannel, incomingChannel, "invalid"],
    discordLanguageRoleId: incomingRole,
    automaticDiscordPostsEnabled: true
  },
  series: [{ id: "incoming-1", title: "Incoming series" }],
  posts: [{ id: "incoming-post" }]
};

async function setup(t) {
  const variables = { WEB_USER: "restore-test", WEB_PASSWORD: "local-unit-test", DISCORD_AUTO_POSTS: "false" };
  for (const [key, value] of Object.entries(variables)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anime-backup-restore-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, "isolated-db.json"));
  await store.init();
  await store.replaceData({
    settings: { discordChannelIds: [currentChannel], automaticDiscordPostsEnabled: false },
    series: [{ id: "local-1", title: "Local series" }, { id: "local-2", title: "Another local series" }],
    posts: []
  });
  const discord = {
    enabled: false,
    listTextChannels: async () => [],
    listMentionRoles: async () => [],
    post() { assert.fail("Backup operations must not send Discord messages"); }
  };
  const server = createWebApp(store, discord).listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const authorization = `Basic ${Buffer.from(`${variables.WEB_USER}:${variables.WEB_PASSWORD}`).toString("base64")}`;
  const request = (url, options, authenticate = true) => fetch(base + url, {
    redirect: "manual", ...options, headers: authenticate ? { authorization } : {}
  });
  const confirm = (token, authenticate) => request("/database/restore", {
    method: "POST", body: new URLSearchParams({ restoreToken: token })
  }, authenticate);
  const upload = (content) => {
    const form = new FormData();
    form.append("databaseFile", new Blob([JSON.stringify(content)], { type: "application/json" }), "backup.json");
    return request("/database/import", { method: "POST", body: form });
  };
  return { directory, store, confirm, request, upload };
}

async function readReview(response, status = 200) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const $ = load(await response.text());
  const token = $('input[name="restoreToken"]').val();
  assert.ok(token);
  const row = (label) => $("tbody tr").filter((_, tr) => $(tr).find("th").text() === label).find("td")
    .map((_, td) => $(td).text().trim()).get();
  return { $, token, row };
}

test("reviews normalized backup values, then checkpoints the prior DB for authenticated download and restore", async (t) => {
  const { store, request, upload, confirm } = await setup(t);
  const original = store.snapshot();
  const initialFile = await fs.readFile(store.filePath, "utf8");
  const review = await readReview(await upload({ app: "Anime Sheduler", version: "1.9.8", data: incoming }));
  assert.deepEqual(review.row("Series"), ["2", "1"]);
  assert.deepEqual(review.row("Post logs"), ["0", "1"]);
  assert.deepEqual(review.row("Discord channels"), [currentChannel, incomingChannel]);
  assert.deepEqual(review.row("Language roles")[1], incomingRole);
  assert.deepEqual(review.row("Automatic Discord posts (saved setting)"), ["Off", "On"]);
  assert.match(review.$("body").text(), /Automatic Discord posts are disabled by this server/);

  assert.equal((await confirm(review.token, false)).status, 401);
  const unreviewed = await confirm("a different token");
  assert.match(decodeURIComponent(unreviewed.headers.get("location")), /backup review is no longer available/);
  assert.deepEqual(store.snapshot(), original);
  assert.equal(await fs.readFile(store.filePath, "utf8"), initialFile);
  assert.equal(await store.hasRestoreSnapshot(), false);

  const restored = await confirm(review.token);
  assert.equal(restored.status, 302);
  assert.match(decodeURIComponent(restored.headers.get("location")), /Backup restored: 1 series, 1 post logs/);
  assert.equal(store.getSeries("incoming-1").title, "Incoming series");
  assert.equal(store.getSeries("local-1"), null);
  assert.deepEqual(store.getSettings().discordChannelIds, [incomingChannel]);

  assert.equal((await request("/database/rollback-copy", {}, false)).status, 401);
  const rollback = await request("/database/rollback-copy");
  assert.equal(rollback.status, 200);
  assert.equal(rollback.headers.get("cache-control"), "no-store");
  assert.match(rollback.headers.get("content-disposition"), /before-restore\.json/);
  const priorDatabase = await rollback.json();
  assert.deepEqual(priorDatabase, original);
  assert.match(await (await request("/settings")).text(), /Download pre-restore backup/);

  const invalidReplay = await confirm(review.token);
  assert.match(decodeURIComponent(invalidReplay.headers.get("location")), /backup review is no longer available/);
  const rollbackReview = await readReview(await upload(priorDatabase));
  assert.equal((await confirm(rollbackReview.token)).status, 302);
  const withoutUpdateTimes = (data) => ({
    ...data, series: data.series.map(({ updatedAt, ...series }) => series)
  });
  assert.deepEqual(withoutUpdateTimes(store.snapshot()), withoutUpdateTimes(original));
  assert.equal(JSON.parse(await store.readRestoreSnapshot()).series[0].title, "Incoming series");
});

test("requires another confirmation if relevant current settings change after review", async (t) => {
  const { store, upload, confirm } = await setup(t);
  const first = await readReview(await upload(incoming));
  const updatedChannel = "444444444444444444";
  await store.updateSettings({ ...store.getSettings(), discordChannelIds: [updatedChannel] });
  const refreshed = await readReview(await confirm(first.token), 409);
  assert.notEqual(refreshed.token, first.token);
  assert.match(refreshed.$("body").text(), /Review the updated comparison/);
  assert.deepEqual(refreshed.row("Discord channels"), [updatedChannel, incomingChannel]);
  assert.equal(await store.hasRestoreSnapshot(), false);
  assert.equal((await confirm(refreshed.token)).status, 302);
  assert.deepEqual(JSON.parse(await store.readRestoreSnapshot()).settings.discordChannelIds, [updatedChannel]);
});

test("invalid backups and a failed checkpoint leave both the in-memory and on-disk databases in place", async (t) => {
  const { directory, store, upload, confirm } = await setup(t);
  const original = store.snapshot();
  const initialFile = await fs.readFile(store.filePath, "utf8");
  const invalid = await upload({ settings: {}, series: [null] });
  assert.match(decodeURIComponent(invalid.headers.get("location")), /does not look like an Anime Sheduler database export/);
  assert.equal(await store.hasRestoreSnapshot(), false);

  const review = await readReview(await upload(incoming));
  await fs.mkdir(path.join(directory, ".isolated-db.json.before-restore.json"));
  const failed = await confirm(review.token);
  assert.match(decodeURIComponent(failed.headers.get("location")), /Could not save the rollback copy or replace the database/);
  assert.deepEqual(store.snapshot(), original);
  assert.equal(await fs.readFile(store.filePath, "utf8"), initialFile);
  assert.equal(await store.hasRestoreSnapshot(), false);
  assert.deepEqual((await fs.readdir(directory)).sort(), [".isolated-db.json.before-restore.json", "isolated-db.json"]);
});
