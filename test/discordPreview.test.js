import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { load } from "cheerio";
import { Settings } from "luxon";
import { createStore } from "../src/store.js";
import { createWebApp } from "../src/web.js";

test("Discord preview uses the unsaved form and stays read-only even when the bot is offline", async t => {
  const originalNow = Settings.now;
  Settings.now = () => Date.parse("2026-11-10T10:00:00+01:00");
  t.after(() => { Settings.now = originalNow; });

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anime-discord-preview-"));
  const database = path.join(directory, "isolated-db.json");
  t.after(async () => {
    await fs.rm(database, { force: true });
    await fs.rmdir(directory);
  });
  const store = createStore(database);
  await store.init();
  const channelIds = ["111111111111111111", "222222222222222222"];
  const missingTimeRoleIds = ["333333333333333333"];
  await store.updateSettings({ ...store.getSettings(), timeZone: "Europe/Berlin", discordChannelIds: channelIds,
    discordReleaseRoleIds: ["444444444444444444"], discordMissingTimeRoleIds: missingTimeRoleIds, missingTimePostTime: "19:45" });

  const series = await store.upsertSeries({ title: "Saved series", status: "airing", enabled: true, weekly: false,
    nextEpisode: 5, nextDate: "2026-11-11", releaseTime: "17:00", episodeCount: 12, service: "ADN" });
  const snapshot = store.snapshot();
  const savedFile = await fs.readFile(database, "utf8");
  const sent = [];
  const discord = {
    enabled: false,
    async post(message, channels, options) {
      sent.push({ embed: message.embeds[0].toJSON(), channels, options });
    }
  };
  const server = createWebApp(store, discord).listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const seriesUrl = `http://127.0.0.1:${server.address().port}/series/${encodeURIComponent(series.id)}`;
  const headers = process.env.WEB_PASSWORD ? {
    Authorization: `Basic ${Buffer.from(`${process.env.WEB_USER || "admin"}:${process.env.WEB_PASSWORD}`).toString("base64")}`
  } : {};

  const editor = await fetch(seriesUrl, { headers });
  assert.equal(editor.status, 200);
  const $ = load(await editor.text());
  assert.equal($("button[data-discord-preview-url]").attr("disabled"), undefined);
  assert.equal($("button[data-discord-preview-url]").attr("type"), "button");
  assert.equal($("button[formaction$='/test-post']").attr("disabled"), "disabled");
  const body = new URLSearchParams();
  $("#series-form input, #series-form select, #series-form textarea").each((_, element) => {
    const field = $(element);
    const name = field.attr("name");
    const checkbox = field.attr("type") === "checkbox";
    if (!name || (checkbox && !field.is(":checked"))) return;
    body.append(name, checkbox ? "on" : field.val() || "");
  });
  body.set("title", "Draft title");
  body.set("note", "Unsaved description");
  body.set("releaseTime", "");
  body.set("nextEpisode", "7");
  body.set("service", "ADN,Crunchyroll");
  body.set("preferredService", "Crunchyroll");
  const post = (suffix, form = body) => fetch(`${seriesUrl}/${suffix}`, { method: "POST", body: form, headers, redirect: "manual" });

  const response = await post("discord-preview");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const preview = await response.json();
  assert.match(preview.embed.title, /Draft title.*Episode 07/);
  assert.equal(preview.embed.description, "Unsaved description");
  assert.equal(preview.embed.fields.find(field => field.name.startsWith("Service")).value, "Crunchyroll");
  assert.equal(preview.embed.fields.find(field => field.name === "Auto-post time").value, "19:45 (time missing fallback)");
  assert.deepEqual(preview.channelIds, channelIds);
  assert.deepEqual(preview.roleIds, missingTimeRoleIds);

  const noDate = new URLSearchParams(body);
  noDate.set("nextDate", "");
  const invalid = await post("discord-preview", noDate);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /No release date/);
  assert.deepEqual(sent, []);
  assert.deepEqual(store.snapshot(), snapshot);
  assert.equal(await fs.readFile(database, "utf8"), savedFile);

  discord.enabled = true;
  const explicit = await post("test-post");
  assert.equal(explicit.status, 302);
  assert.match(explicit.headers.get("location"), /Test%20post%20sent/);
  assert.equal(sent.length, 1);
  // The embed timestamps mark the moment each message was prepared.
  const { timestamp: previewTimestamp, ...previewContent } = preview.embed;
  const { timestamp: sentTimestamp, ...sentContent } = sent[0].embed;
  assert.deepEqual(sentContent, previewContent);
  assert.deepEqual(sent[0].options.mentionRoleIds, preview.roleIds);
  assert.equal(store.getSeries(series.id).title, "Draft title");
});
