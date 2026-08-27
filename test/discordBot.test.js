import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { buildAnnouncement, copyableSeriesTitle } from "../src/discordBot.js";

test("removes release qualifiers from copyable series titles", () => {
  const cases = [
    ["The Quintessential Quintuplets Specials", "The Quintessential Quintuplets"],
    ["Skeleton Knight in Another World Season 2", "Skeleton Knight in Another World"],
    ["HELL MODE: The Hardcore Gamer Dominates in Another World with Garbage Balancing 2nd Season", "HELL MODE: The Hardcore Gamer Dominates in Another World with Garbage Balancing"],
    ["Yoroi-Shinden Samurai Troopers Cour 2", "Yoroi-Shinden Samurai Troopers"],
    ["Lord of Mysteries (Special)", "Lord of Mysteries"],
    ['Mr. Osomatsu 4th Season Episode 13 "The Matsuno Ten"', "Mr. Osomatsu"],
    ["Bananya 10th Anniversary Special", "Bananya 10th Anniversary"]
  ];

  for (const [title, expected] of cases) {
    assert.equal(copyableSeriesTitle(title), expected);
  }
});

test("keeps meaningful title words that are not release qualifiers", () => {
  assert.equal(
    copyableSeriesTitle("Ascendance of a Bookworm: Adopted Daughter of an Archduke"),
    "Ascendance of a Bookworm: Adopted Daughter of an Archduke"
  );
  assert.equal(copyableSeriesTitle("Final Episode"), "Final Episode");
  assert.equal(copyableSeriesTitle("GROW UP SHOW -Sunflower Circus-"), "GROW UP SHOW -Sunflower Circus-");
});

test("adds the cleaned title as a text code block to announcements", () => {
  const message = buildAnnouncement(
    {
      title: "The Quintessential Quintuplets Specials",
      service: "Crunchyroll",
      preferredService: "",
      streamingServiceId: "G6EXAMPLE123",
      scheduleLink: "https://www.livechart.me/anime/11921/schedules",
      imageUrl: "",
      note: "",
      nextEpisode: 1,
      episodeBatchSize: 1,
      languageTracks: []
    },
    {
      kind: "main",
      dateTime: DateTime.fromISO("2026-07-27T18:00:00", { zone: "Europe/Berlin" }),
      missingTime: false
    },
    {
      timeZone: "Europe/Berlin",
      missingTimePostTime: "18:00"
    }
  );

  const metadataFields = message.embeds[0].data.fields.slice(0, 6);
  assert.ok(metadataFields.every((item) => item.inline));
  assert.deepEqual(metadataFields.map((item) => item.name), [
    `Date\u2060${"\u2800\u2060".repeat(10)}`,
    `Time\u2060${"\u2800\u2060".repeat(10)}`,
    `Episode\u2060${"\u2800\u2060".repeat(8)}`,
    `Service\u2060${"\u2800\u2060".repeat(8)}`,
    `Version\u2060${"\u2800\u2060".repeat(8)}`,
    `Source\u2060${"\u2800\u2060".repeat(9)}`
  ]);

  const field = message.embeds[0].data.fields.find((item) => item.name.startsWith("Title"));
  assert.deepEqual(field, {
    name: "Title",
    value: "```text\nThe Quintessential Quintuplets\n```",
    inline: false
  });
  assert.deepEqual(message.embeds[0].data.fields.find((item) => item.name === "Service ID"), {
    name: "Service ID",
    value: "```text\nG6EXAMPLE123\n```",
    inline: false
  });
  assert.equal(message.embeds[0].data.fields.some((item) => item.name === "\u200B"), false);
});

test("omits the service ID copy field when no ID was entered", () => {
  const message = buildAnnouncement(
    {
      title: "Series without service ID",
      service: "Crunchyroll",
      preferredService: "",
      streamingServiceId: "",
      scheduleLink: "",
      imageUrl: "",
      note: "",
      nextEpisode: 1,
      episodeBatchSize: 1,
      languageTracks: []
    },
    {
      kind: "main",
      dateTime: DateTime.fromISO("2026-07-27T18:00:00", { zone: "Europe/Berlin" }),
      missingTime: false
    },
    {
      timeZone: "Europe/Berlin",
      missingTimePostTime: "18:00"
    }
  );

  assert.equal(message.embeds[0].data.fields.some((item) => item.name === "Service ID"), false);
});
