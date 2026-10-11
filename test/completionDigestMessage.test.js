import test from "node:test";
import assert from "node:assert/strict";
import { EmbedBuilder, MessagePayload } from "discord.js";
import { DateTime } from "luxon";
import { buildCompletionAnnouncement, buildCompletionDigestAnnouncement } from "../src/discordBot.js";

const settings = { timeZone: "Europe/Berlin" };
const now = DateTime.fromISO("2026-10-12T18:00:00", { zone: settings.timeZone });
const example = {
  title: "Example Season 2 Cour 3", episodeCount: 12,
  service: "Crunchyroll,ADN", preferredService: "ADN",
  scheduleLink: "https://www.livechart.me/anime/11218/schedules", tvdbId: "123456"
};

async function resolveMessage(t, message) {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request"); });
  const target = { client: { options: { enforceNonce: false, jsonTransformer: (value) => value } } };
  const payload = new MessagePayload(target, message).resolveBody();
  await payload.resolveFiles();
  assert.equal(payload.body.embeds.length, 1, "digest stays in one Discord message and one embed");
  const embed = EmbedBuilder.from(payload.body.embeds[0]).toJSON();
  assert.ok(embed.description.length <= 4096);
  assert.ok((embed.title?.length || 0) + embed.description.length <= 6000);
  assert.deepEqual(payload.body.allowed_mentions, { parse: [] });
  assert.equal(payload.body.content, undefined);
  return { payload, embed };
}

test("compact digest preserves full season titles, preferred services, metadata and input order", async (t) => {
  const message = buildCompletionDigestAnnouncement([
    example,
    { title: "Second series Part 2", episodeCount: null, service: "", tvdbId: "" }
  ], settings, now);
  const { payload, embed } = await resolveMessage(t, message);
  assert.equal(embed.title, "Open completion reminders");
  assert.match(embed.description, /2 completed series are awaiting confirmation/);
  assert.match(embed.description, /Completion tab.*Completion handled/);
  assert.match(embed.description, /\*\*Example Season 2 Cour 3\*\* — Episodes: 12 · Service: ADN/);
  assert.match(embed.description, /\[LiveChart\]\(https:\/\/www\.livechart\.me\/anime\/11218\/schedules\)/);
  assert.match(embed.description, /TVDB ID: 123456/);
  assert.match(embed.description, /Second series Part 2\*\* — Episodes: Unknown · Service: Unknown/);
  assert.ok(embed.description.indexOf(example.title) < embed.description.indexOf("Second series Part 2"));
  assert.equal(embed.timestamp, now.toUTC().toISO());
  assert.equal(payload.files.length, 0);
});

test("large digests attach every full row instead of dropping entries or splitting messages", async (t) => {
  const entries = Array.from({ length: 250 }, (_, index) => ({
    ...example,
    title: `Series ${String(index).padStart(3, "0")} Season 2 Cour 3 — ${"Full title ".repeat(15).trim()}`,
    tvdbId: String(100000 + index)
  }));
  const message = buildCompletionDigestAnnouncement(entries, settings, now);
  const { payload, embed } = await resolveMessage(t, message);
  assert.match(embed.description, /250 completed series/);
  assert.match(embed.description, /of 250 shown; the complete list is attached/);
  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].name, "open-completions.txt");
  const allRows = payload.files[0].data.toString("utf8");
  assert.equal(allRows.split("\n").filter((line) => line.startsWith("- ")).length, entries.length);
  for (const entry of entries) {
    assert.ok(allRows.includes(entry.title), `missing full title ${entry.title}`);
    assert.ok(allRows.includes(`TVDB ID: ${entry.tvdbId}`));
  }
  assert.ok(allRows.indexOf(entries[0].title) < allRows.indexOf(entries.at(-1).title));
  assert.match(allRows, /LiveChart: https:\/\/www\.livechart\.me\/anime\/11218\/schedules/);
});

test("the Discord description boundary is respected, including one enormous title", async (t) => {
  const base = { title: "X", episodeCount: 1, service: "ADN" };
  const baseLength = buildCompletionDigestAnnouncement([base], settings, now).embeds[0].toJSON().description.length;
  const exactTitle = "X".repeat(4096 - baseLength + 1);
  const exactMessage = buildCompletionDigestAnnouncement([{ ...base, title: exactTitle }], settings, now);
  const { payload: exact, embed } = await resolveMessage(t, exactMessage);
  assert.equal(embed.description.length, 4096);
  assert.equal(exact.files.length, 0);

  const hugeTitle = `${exactTitle}X`;
  const overMessage = buildCompletionDigestAnnouncement([{ ...base, title: hugeTitle }], settings, now);
  const { payload: overflow, embed: overflowEmbed } = await resolveMessage(t, overMessage);
  assert.match(overflowEmbed.description, /0 of 1 shown/);
  assert.equal(overflow.files.length, 1);
  assert.ok(overflow.files[0].data.toString("utf8").includes(hugeTitle));
});

test("untrusted titles cannot inject Markdown links or Discord mentions", async (t) => {
  const title = "[Click](https://example.com) **Bold** `code` <@&123456789012345678> @everyone\nNew line";
  const message = buildCompletionDigestAnnouncement([{
    ...example, title, service: "@here", preferredService: "",
    tvdbId: "[123](https://example.com)",
    scheduleLink: "https://www.livechart.me/anime/11218/schedules?note=(test)"
  }], { ...settings, discordReleaseRoleIds: ["123456789012345678"] }, now);
  const { embed } = await resolveMessage(t, message);
  assert.ok(embed.description.includes("\\[Click\\]\\(https://example.com\\)"));
  assert.ok(embed.description.includes("\\*\\*Bold\\*\\*"));
  assert.ok(embed.description.includes("@\u200Beveryone"));
  assert.ok(embed.description.includes("@\u200Bhere"));
  assert.equal(embed.description.includes("<@&123456789012345678>"), false);
  assert.match(embed.description, /note=%28test%29/);
  assert.equal(embed.description.includes("@everyone"), false);
  assert.equal(embed.description.includes("New line\n"), false);
});

test("empty digests and invalid links remain valid single messages", async (t) => {
  const empty = await resolveMessage(t, buildCompletionDigestAnnouncement([], settings, now));
  assert.equal(empty.embed.description, "No completed series are awaiting confirmation.");
  assert.equal(empty.payload.files.length, 0);
  const invalid = await resolveMessage(t, buildCompletionDigestAnnouncement([
    { title: "Safe title", episodeCount: 0, scheduleLink: "javascript:alert(1)" }
  ], settings, now));
  assert.match(invalid.embed.description, /1 completed series is awaiting confirmation/);
  assert.match(invalid.embed.description, /Episodes: Unknown · Service: Unknown/);
  assert.equal(invalid.embed.description.includes("LiveChart"), false);
  assert.equal(invalid.embed.description.includes("TVDB"), false);
});

test("the first individual notice explains the later weekly digest", () => {
  const embed = buildCompletionAnnouncement({ ...example, finishedAt: now.minus({ weeks: 1 }).toISO() }, settings, now)
    .embeds[0].toJSON();
  assert.match(embed.description, /first notice.*one week after completion/);
  assert.match(embed.description, /weekly digest.*handled.*Completion tab/);
});
