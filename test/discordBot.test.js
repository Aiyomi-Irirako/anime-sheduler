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

  const field = message.embeds[0].data.fields.find((item) => item.name === "Title to copy");
  assert.deepEqual(field, {
    name: "Title to copy",
    value: "```text\nThe Quintessential Quintuplets\n```",
    inline: false
  });
  assert.equal(message.embeds[0].data.fields.some((item) => item.name === "\u200B"), false);
});
