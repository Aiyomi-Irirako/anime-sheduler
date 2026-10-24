import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { parseLiveChartEpisodes } from "../src/livechart.js";
import { normalizeLateDubNotices, planLateDubNotices } from "../src/lateDub.js";
import { buildLateDubAnnouncement } from "../src/discordBot.js";

const now = DateTime.fromISO("2026-10-25T00:26:00", { zone: "Europe/Berlin" });
const settings = { timeZone: "Europe/Berlin", enabledLanguageCodes: ["de"] };
const past = now.minus({ days: 2 });
const next = now.plus({ days: 5 }).set({ hour: 18, minute: 30 });
const track = { code: "de", enabled: true, available: true, nextEpisode: 2,
  nextDate: next.toISODate(), releaseTime: "18:30", weekly: true };
const series = { id: "appraisal", title: "Appraisal Skill Season 3", enabled: true, status: "airing",
  service: "Crunchyroll", episodeCount: 12, languageTracks: [track],
  scheduleLink: "https://www.livechart.me/anime/12345/schedules", tvdbId: "123456" };
function row({ label = "EP1", at = past, code = "de", confirm = false, region = false,
  released = false, partial = "", id = "20" } = {}) {
  return `<article data-release-schedule-release-schedule-id="${id}">
    <a href="/anime/12345/schedules/${id}">${released ? "Released" : `<time data-label="${label}"${at ? ` data-timestamp="${at.toSeconds()}"` : ""}>${label}</time>`}
    ${confirm ? "This release requires confirmation." : ""}${region ? "This might not apply to your region." : ""}</a>
    <a title="Simulcast: Dubbed">Simulcast: Dubbed</a>
    ${partial ? `<span data-intl-time-datetime="${partial}" data-intl-time-precision="3"></span>` : ""}
    <span><svg><use href="#icon:audio"></use></svg></span>
    <span data-tracklist-json="{&quot;${code}&quot;:[&quot;DE&quot;]}"></span>
    <span class="lc-text-contextual-accent">Crunchyroll</span></article>`;
}
const parse = (html, options = {}) => parseLiveChartEpisodes(html, {
  nowTimestamp: now.toSeconds(), timeZone: settings.timeZone, ...options
});

test("explicit expired premiere evidence stays separate from the next dub schedule", () => {
  const live = parse(row() + row({ label: "EP2", at: next, id: "21" }));
  assert.equal(live.languageTracks.length, 1);
  assert.equal(live.languageTracks[0].nextEpisode, 2);
  assert.deepEqual(live.lateDubReleases, [{ languageCode: "de", episode: 1, episodeEnd: 1,
    releaseAt: past.toUTC().toISO() }]);
  assert.equal(parse(row()).languageTracks.length, 0, "an expired date never revives the normal schedule");
});

test("late premiere evidence starts only after the regular six-hour posting window", () => {
  const html = row({ at: now.minus({ hours: 6 }) });
  const options = { pendingLanguageTracks: [{ code: "de", enabled: true, nextEpisode: 1 }] };
  const onBoundary = parse(html, options);
  assert.equal(onBoundary.languageTracks.length, 1);
  assert.equal(onBoundary.lateDubReleases.length, 0);
  const expired = parse(html, { ...options, nowTimestamp: now.plus({ seconds: 1 }).toSeconds() });
  assert.equal(expired.languageTracks.length, 0);
  assert.equal(expired.lateDubReleases.length, 1);
});

test("only explicit, recent, applicable and confirmed premiere rows become late evidence", () => {
  for (const options of [{ confirm: true }, { region: true }, { released: true },
    { at: null, partial: past.toISODate() }, { at: now.minus({ days: 15 }) },
    { label: "EP4" }, { label: "Upcoming" }, { code: "ja" }]) {
    assert.deepEqual(parse(row(options)).lateDubReleases, [], JSON.stringify(options));
  }
  assert.equal(parse(row({ at: now.minus({ days: 14 }) })).lateDubReleases.length, 1);
});

test("late batch evidence retains all 120 episodes without changing the future schedule", () => {
  const live = parse(row({ label: "All 120 EPs" }) + row({ label: "EP121", at: next, id: "21" }));
  assert.equal(live.lateDubReleases[0].episodeEnd, 120);
  const notices = planLateDubNotices({ ...series, episodeCount: 132,
    languageTracks: [{ ...track, nextEpisode: 121 }] }, live, settings, now);
  assert.equal(notices[0].kind, "release");
  assert.equal(notices[0].episodeEnd, 120);
  assert.equal(notices[0].nextEpisode, 121);
});

test("a first-seen future episode two gets a schedule notice without inventing episode one", () => {
  const before = structuredClone(series);
  const notice = planLateDubNotices(series, { languageTracks: [track] }, settings, now)[0];
  assert.equal(notice.kind, "schedule");
  assert.equal(notice.nextEpisode, 2);
  assert.equal(notice.nextReleaseAt, next.toUTC().toISO());
  assert.equal(notice.episode, null);
  assert.equal(notice.episodeEnd, null);
  assert.equal(notice.releaseAt, "");
  assert.equal(notice.detectedAt, now.toUTC().toISO());
  assert.deepEqual(series, before);
});

test("an explicit late release takes precedence over a generic future schedule notice", () => {
  const live = parse(row() + row({ label: "EP2", at: next, id: "21" }));
  const notice = planLateDubNotices(series, live, settings, now)[0];
  assert.equal(notice.kind, "release");
  assert.equal(notice.episode, 1);
  assert.equal(notice.releaseAt, past.toUTC().toISO());
  assert.equal(notice.nextEpisode, 2);
});

test("rescheduling the same known dub episode does not create a late introduction", () => {
  for (const previousDate of [past, next.minus({ days: 1 }), next.plus({ days: 1 })]) {
    const previous = { ...track, nextDate: previousDate.toISODate(),
      releaseTime: previousDate.toFormat("HH:mm") };
    const notice = planLateDubNotices(series, { previousLanguageTracks: [previous] }, settings, now)[0];
    assert.equal(notice.suppressed, true);
    assert.equal(notice.notifiedAt, "");
  }
  for (const releaseTime of ["18:00", "19:00"]) {
    const sameDayChanged = { ...track, releaseTime };
    const notice = planLateDubNotices(series, { previousLanguageTracks: [sameDayChanged] }, settings, now)[0];
    assert.equal(notice.suppressed, true);
    assert.equal(notice.notifiedAt, "");
  }
});

test("rescheduling suppression survives unchanged syncs and normalized backup reloads", () => {
  const previous = { ...track, nextDate: next.minus({ days: 1 }).toISODate() };
  const planned = planLateDubNotices(series, { previousLanguageTracks: [previous] }, settings, now);
  const restored = normalizeLateDubNotices(JSON.parse(JSON.stringify(planned)));
  assert.deepEqual(restored, planned);
  assert.equal(restored[0].suppressed, true);
  assert.equal(restored[0].notifiedAt, "");
  const nextSync = planLateDubNotices({ ...series, lateDubNotices: restored }, {
    previousLanguageTracks: [{ ...track }]
  }, settings, now.plus({ minutes: 1 }));
  assert.deepEqual(nextSync, restored);
  assert.equal(nextSync.filter((notice) => !notice.suppressed && !notice.notifiedAt).length, 0);
  for (const suppressed of [false, "true", 1, null]) {
    assert.equal(Object.hasOwn(normalizeLateDubNotices([{ ...restored[0], suppressed }])[0], "suppressed"), false);
  }
});

test("unchanged dates, different episodes and newly dated tracks retain late-notice eligibility", () => {
  for (const previousTracks of [[{ ...track }], [{ ...track, nextEpisode: 1 }],
    [{ ...track, nextDate: "", releaseTime: "" }], [{ ...track, releaseTime: "" }], []]) {
    const notices = planLateDubNotices(series, { previousLanguageTracks: previousTracks }, settings, now);
    assert.equal(notices.length, 1, JSON.stringify(previousTracks));
    assert.equal(notices[0].kind, "schedule");
  }
});

test("explicit past premiere evidence is retained even when the next episode is postponed", () => {
  const live = { ...parse(row()), previousLanguageTracks: [{ ...track,
    nextDate: next.minus({ days: 1 }).toISODate() }] };
  const notices = planLateDubNotices(series, live, settings, now);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "release");
  assert.equal(notices[0].episode, 1);
});

test("a configured new language can create an exact late notice before a track exists", () => {
  const live = parse(row());
  assert.equal(planLateDubNotices({ ...series, languageTracks: [] }, live, settings, now).length, 1);
  assert.equal(planLateDubNotices({ ...series, languageTracks: [] }, live, { ...settings,
    enabledLanguageCodes: [] }, now).length, 0);
});

test("disabled series, explicitly disabled tracks and unavailable versions do not queue notices", () => {
  for (const entry of [{ ...series, enabled: false },
    { ...series, languageTracks: [{ ...track, enabled: false }] },
    { ...series, languageTracks: [{ ...track, available: false }] },
    { ...series, liveChartImportLanguage: "fr" }]) {
    assert.deepEqual(planLateDubNotices(entry, {}, settings, now), []);
  }
});

test("posted and paused language tracks never acquire a new late schedule notice", () => {
  for (const patch of [{ lastPostedKey: "appraisal:language:de:1:release-time:2026-10-23T18:00:00+02:00" },
    { lastPostedAt: past.toISO() }, { nextDate: "", releaseTime: "", releaseDay: "" }]) {
    assert.deepEqual(planLateDubNotices({ ...series, languageTracks: [{ ...track, ...patch }] }, {}, settings, now), []);
  }
});

test("episode one, missing time, undated and past next schedules do not imply missing episodes", () => {
  for (const patch of [{ nextEpisode: 1 }, { releaseTime: "" }, { nextDate: "" },
    { nextDate: past.toISODate() }, { nextEpisode: null }]) {
    assert.deepEqual(planLateDubNotices({ ...series, languageTracks: [{ ...track, ...patch }] }, {}, settings, now), []);
  }
});

test("manual late premiere dates can queue an exact notice without inventing a weekly date", () => {
  const entry = { ...series, scheduleMode: "manual", languageTracks: [{ ...track, nextEpisode: 1,
    episodeBatchSize: 120, nextDate: past.toISODate(), releaseTime: past.toFormat("HH:mm") }] };
  const notice = planLateDubNotices(entry, {}, settings, now)[0];
  assert.equal(notice.kind, "release");
  assert.equal(notice.episodeEnd, 120);
  assert.equal(notice.nextReleaseAt, "");
  assert.equal(entry.languageTracks[0].nextDate, past.toISODate());
});

test("saved receipts survive planning and prevent a second notice for that language", () => {
  const first = planLateDubNotices(series, {}, settings, now)[0];
  const saved = { ...first, notifiedAt: now.toISO(), sentChannelIds: ["111111111111111111"] };
  const result = planLateDubNotices({ ...series, lateDubNotices: [saved],
    languageTracks: [{ ...track, nextEpisode: 3 }] }, {}, settings, now.plus({ days: 7 }));
  assert.deepEqual(result, normalizeLateDubNotices([saved]));
  assert.equal(result.length, 1);
});

test("normalization rejects malformed notices and derives stable keys from source dates", () => {
  const notice = planLateDubNotices(series, {}, settings, now)[0];
  const sameInstant = { ...notice, key: "untrusted", nextReleaseAt: next.toISO(),
    sentChannelIds: ["111111111111111111", "111111111111111111", "bad"] };
  const normalized = normalizeLateDubNotices([null, {}, { ...notice, languageCode: "ja" }, sameInstant,
    { ...notice, nextEpisode: 3 }]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].key, notice.key);
  assert.deepEqual(normalized[0].sentChannelIds, ["111111111111111111"]);
  for (const patch of [{ kind: "bad" }, { nextReleaseAt: "bad" }, { nextEpisode: -1 }, { nextEpisode: 1 }]) {
    assert.deepEqual(normalizeLateDubNotices([{ ...notice, ...patch }]), []);
  }
});

test("generic late messages show only the next listed release and preserve copy metadata", () => {
  const notice = planLateDubNotices(series, {}, settings, now)[0];
  const message = buildLateDubAnnouncement(series, notice, settings, now);
  const embed = message.embeds[0].toJSON();
  assert.match(embed.title, /Late dub update/);
  assert.match(embed.description, /German dub.*Episode 2.*next listed release/);
  assert.doesNotMatch(embed.description, /available now|Episode 1/);
  assert.equal(embed.fields.find((field) => field.name === "Next listed episode").value, "Episode 02/12 (German)");
  assert.ok(embed.fields.find((field) => field.name === "Next listed date").value.includes("30 Oct 2026"));
  assert.equal(embed.fields.find((field) => field.name.startsWith("Version")).value, "German");
  assert.equal(embed.fields.find((field) => field.name === "TVDB ID").value, "```text\n123456\n```");
  assert.equal(embed.timestamp, now.toUTC().toISO());
  assert.deepEqual(message.allowedMentions, { parse: [] });
});

test("exact late messages distinguish the original date and full episode batch", () => {
  const live = parse(row({ label: "All 120 EPs" }));
  const entry = { ...series, episodeCount: 120, languageTracks: [] };
  const notice = planLateDubNotices(entry, live, settings, now)[0];
  const embed = buildLateDubAnnouncement(entry, notice, settings, now).embeds[0].toJSON();
  assert.match(embed.description, /Late announcement.*German dub.*original release date/);
  assert.equal(embed.fields.find((field) => field.name.startsWith("Episode")).value, "Episode 01-120/120 (German)");
  assert.ok(embed.fields.find((field) => field.name.startsWith("Date")).value.includes("23 Oct 2026"));
});
