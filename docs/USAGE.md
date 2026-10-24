# Usage Guide

This guide covers CSV import, release editing, language versions, LiveChart sync, and Discord posting.

## CSV Import

Use the web panel:

1. Open `Settings`.
2. Open `CSV Import`.
3. Paste your CSV or choose a `.csv` file under `Upload CSV file`.
4. Keep `Update existing series` enabled.
5. Enable `Overwrite schedule and episodes from CSV` only when you intentionally want CSV data to replace manual edits.

Uploaded CSV files are parsed in memory and are not stored on disk. The upload limit is 10 MB.

CLI import:

```bash
pnpm run import -- /path/to/summer-2026.csv
```

Docker CLI import:

```bash
docker compose cp ./summer-2026.csv anime-sheduler:/tmp/summer-2026.csv
docker compose exec anime-sheduler pnpm run import -- /tmp/summer-2026.csv
```

For Docker, the web import is usually easier because you can paste or upload the CSV directly.

## Automatic German Releases

The daily new-series check adds missing series directly to the dashboard when LiveChart lists upcoming German subtitles or German audio. There is no separate discovery tab, selection list, or approval step. Controls and the latest result are under `Settings > LiveChart`. The check is enabled by default and runs once per local day, starting at 06:00 in the configured timezone. Both daily tasks accept an hour and minute, such as 05:15. The app checks locally once per minute whether a task is due; these timer checks do not request LiveChart pages. A missed daily run is caught up when the app starts after the configured time. Existing hour-only settings become the same hour with :00 minutes.

The current and next season overviews are compared with existing entries by LiveChart ID, MAL ID, or an exact title for manual entries without IDs. Only missing titles have their schedule pages requested. A German subtitle OR German dub schedule qualifies; English-only and Japanese-only releases, expired releases and already released catalogue entries do not. German announcements without a known date or episode also qualify. Audio and subtitle metadata are checked separately, including regional warnings. Existing entries and manual service IDs are never overwritten by this check.

German matches are imported immediately with their German services and language tracks, and recorded in the seven-day Changelog. The normal daily sync keeps refreshing them. Dates without times retain `time missing` and the configured fallback; month/year-only dates and unknown episodes have no posting date until LiveChart provides a usable schedule. A `requires confirmation` notice does not erase an otherwise usable release date: the bot follows the listed schedule, which is not independent verification of streaming availability. Imported series retain German schedules during subsequent syncs, without substituting Japanese/English broadcasts. TVDB/TMDB IDs are not supplied by LiveChart.

Only the latest run's timestamp, summary and error are retained. There is no persistent candidate list or daily history. Titles without German releases are skipped and can qualify on a later daily check if a German version is announced. The first run can take several minutes: besides the two overview pages, it needs one schedule request for each missing title and one detail request for each German match. Later runs skip already imported entries entirely. Manual checks have a one-hour cooldown; failed automatic runs are not repeatedly retried within the same local day, including after a restart.

All LiveChart HTTP requests share a sequential queue with at least 6.5 seconds between requests. Detail pages use a bounded cache; schedule checks remain fresh. HTTP 403/429 or an access challenge stops further requests for at least 24 hours in that process (or longer if Retry-After requires it). This reduces load but cannot guarantee uninterrupted access. LiveChart has no public API, so HTML changes may require parser updates.

## Editing Releases

- `New Series`: paste a LiveChart anime or schedule link to load the title automatically. A typed title is preserved. Without a LiveChart link, enter a title manually. Failed lookups retain the form without creating an empty entry.
- `Load from LiveChart`: load metadata and upcoming German subtitle/dub releases into the form, including older titles outside the current seasons. Review the form and click `Save` to create or update the entry. Loading alone never saves or posts. Links to a specific release schedule follow that schedule only; unavailable or unsuitable selections are reported instead of silently selecting another release.
- `Schedule source`: `Follow LiveChart` uses the normal daily and pre-post sync. `Manual schedule` keeps the entered dates, episodes, services and language versions unchanged by LiveChart; both daily and pre-post schedule requests are skipped for that entry. The link remains available for metadata lookup. Existing entries default to `Follow LiveChart`.
- If LiveChart has no upcoming German release, `Load from LiveChart` loads only metadata and selects `Manual schedule`, keeping entered release fields. This supports later catalogue releases announced elsewhere. Switching back to `Follow LiveChart` allows its schedules to replace the manual values again.
- Duplicate protection applies to manual saves, CSV imports and automatic discovery. LiveChart URL variants for the same anime and matching MAL IDs identify the same series; otherwise normalized exact titles are compared unless both entries have different source IDs. Separate seasons are not matched by fuzzy title rules. Manual duplicates open the existing entry without overwriting it. Older duplicates in backups are not silently deleted.
- `Release day` and `Time`: normal weekly schedule.
- `Next date`: manual override for a delayed or moved episode.
- `Episodes this release`: enter up to `10000` when a service releases multiple episodes at once, for both the main release and dub versions. A complete 120-episode release uses `120` here and `120` in `Total episodes`; the Discord post shows `Episode 01-120/120`. After posting, the scheduler advances past the entire batch (or finishes the series) and resets the batch size to `1`.
- `Weekly release` sets the main release to one episode at a time with weekly continuation. `Complete series` uses the known total episode count, starts at episode 1 and disables weekly continuation. Enter the release date separately. Dub tracks keep their independent episode/date/batch fields.
- `Language Versions`: enable additional language versions and set their next episode numbers.
- Language version schedules: each enabled language can have its own weekday, time, or manual next date.
- `Send test post` selects the earliest relevant main or dub release, including entries with only a dub schedule. Versions are combined only when their posting time and missing-time mode match. Old main dates do not hide a newly scheduled dub. For a manually entered dub-only release, clear the main `Next episode`, `Next date` and `Release day`, then enable the matching language under `Dub Versions` with its own episode and date.
- For LiveChart-managed dubs, a successful sync clears extrapolated weekly dates when the source has no usable upcoming release. Paused dubs wait for a new source date without being marked complete. A later rescheduled release can also correct an episode counter that previously advanced too far; earlier post history remains intact.
- `Auto-enabled languages`: global settings for language versions found by LiveChart.
- `LiveChart sync`: updates a single series from its LiveChart schedule link.
- LiveChart sync overwrites the main release date, weekday, and time when LiveChart exposes an exact timestamp.
- Date-only updates clear stale times; month/year-only updates clear stale posting dates. This also applies to explicitly updated dub schedules.
- LiveChart language times: when LiveChart exposes a timestamp for a language version, the bot stores it as that language's next date and release time.
- Sync can restore a missing dub date for an enabled, still-unposted episode up to six hours after its listed release time. This does not re-send an already posted original episode or import old releases into newly discovered series. Older missed announcements are not posted automatically.
- `Image URL`: optional poster or cover image used as a small Discord thumbnail. LiveChart sync can fill this automatically when available.
- `Streaming service ID`: optional manual series ID for the selected posting service. LiveChart sync and CSV imports do not overwrite it.
- `Discord announcement channels`: open a server section, then select one or more text channels the bot can access. Release posts are sent to every selected channel.
- `Discord role mentions`: open a server section and select roles for timed main releases, language releases, and missing-time fallback posts. If the bot posts to multiple servers, select the matching role in each server.
- `Sync LiveChart now`: updates all active series that have a LiveChart link.
- `Update from LiveChart once per day`: runs one slow daily sync at the configured time (hours and minutes, in the selected timezone).
- `Continue weekly`: moves a manual `Next date` forward by 7 days after a post.
- A manual release without weekly continuation clears its date and weekday after posting, so an incomplete batch with an unknown total waits for another manually entered date. A complete season with a known total finishes normally.
- Missing time: the panel shows `time missing`, and the scheduler posts it at `MISSING_TIME_POST_TIME`.

The global LiveChart sync intentionally waits between requests to reduce the chance of rate limits.

For an older 12-episode title newly offered in full by Prime Video, load its LiveChart link, choose `Manual schedule` if that new release is not listed, set `Service` to `Prime Video`, `Next date` to the announced date and `Total episodes` to `12`, then click `Complete series`. Leave the time blank if it has not been announced; the configured missing-time fallback applies. Keep the entry active with a planned/airing status. For a dub-only release, leave the original's next episode blank and configure the German dub track instead. An existing finished entry should be edited and reactivated rather than duplicated.

Manual full syncs and single-series syncs run in the background. The start request returns immediately instead of waiting for LiveChart, avoiding long-running requests through a reverse proxy. Settings, Finished and the series editor display progress and the final result. While a sync runs, the page reads `/api/livechart/sync-status` every few seconds; these requests do not contact LiveChart. Updated data reloads when the job finishes, unless the form has unsaved edits.

Manual and daily syncs share one running-job guard, so additional clicks or a daily timer cannot start an overlapping sync. Closing the browser does not stop the job. Progress is kept only in memory; restarting the app interrupts the current job. The latest completed full-sync timestamp and summary remain in the existing settings, with no additional job-history database. The once-daily schedule and LiveChart request throttling are unchanged.

## Changelog

Open `Changelog` in the top navigation to review series changes from the last 7 days. The list includes manual edits, CSV imports, LiveChart sync updates, scheduler advances after Discord posts, and deleted entries. Older entries are removed automatically.

## Discord Posting

The scheduler runs continuously while the bot is active.

### Test Servers

Disable `Automatic Discord posts` under `Settings > Discord` to keep Discord connected without automatic episode, dub, missing-time or completion announcements. LiveChart sync and new-series checks continue normally. Manual test posts, manual summaries and slash commands remain available and can still send messages to the selected channels. Paused automatic posts do not advance episodes or mark notifications as delivered.

For a dedicated test instance, set `DISCORD_AUTO_POSTS=false` in its `.env` before starting it. This server-level lock overrides the saved checkbox, including after restoring a production backup. Restart the app after changing the environment setting (recreate the container with `docker compose up -d --force-recreate` for Docker). The web panel displays the lock. Leave this variable unset or set to `true` on production to preserve normal automatic posting. In-flight Discord requests cannot be recalled; disabling automatic posts stops subsequent scheduler sends. Re-enabling can send releases still within the normal posting window and overdue completion notices.

### Automatic Releases

Before an automatic post is sent for a LiveChart-linked series, the scheduler refreshes that single series from LiveChart and recalculates whether it is still due. If LiveChart moved the episode, the stale post is skipped and the stored entry is updated. If LiveChart replaces the final episode with `Released`, a known, unposted final episode remains eligible within the six-hour posting window. This also applies when a daily sync runs before the scheduler.

If the pre-post refresh advances to a higher episode whose release date is still unknown, the already due episode is still announced within the normal posting window. The higher episode stays stored without inventing its next date. This applies separately to the main release and enabled language versions; it does not recover older posts that were already missed.

If `REMINDER_MINUTES=0`, the bot posts at release time.

If `REMINDER_MINUTES=60`, the bot posts one hour before release time.

If a release has no exact time, the bot posts it at `MISSING_TIME_POST_TIME`. The default is `18:00`.

Automatic release posts and manual series test posts can ping selected Discord roles. Summary posts do not ping those roles.

Release embeds include compact plain-text copy fields for the base anime title and, when entered, its streaming service ID and TVDB ID. The optional TVDB ID can be entered in the series editor or imported from the CSV `tvdb_id` column; LiveChart does not supply it. Trailing labels such as specials, seasons, parts, and cours are omitted from the title field without changing the stored or displayed series title.

Episode fields include the known total, for example `Episode 05/12`, `Episode 05-06/12`, or `Episode 03/12 (German)`. Schedule summaries and the web panel also show totals. Discord embed headings keep the current episode without the total. When the total is unknown, the label stays as `Episode 05` without a guessed denominator. Copy fields contain only the title or ID, not episode information.

The default release description distinguishes new original episodes, dub episodes, and combined releases. For example, a combined original/German release says `New original and German dub episodes are available now.` A custom series note or the missing-time fallback description still takes precedence.

After an automatic post, only the release that was posted is advanced. Main episodes and language versions are tracked separately.

### Late Dub Notices

When a successful LiveChart sync or a saved entry first lists an enabled dub at episode 2 or later, and that language has no previous release post, the bot queues one extra `Late dub update`. It shows the next listed episode and its date; it does not invent a release date or claim availability for earlier episodes. This also applies to newly imported LiveChart entries and existing entries whose undated episode 1 was replaced by a later episode.

If LiveChart still provides an exact, applicable and confirmed episode-1 date from the last 14 days, older than the regular six-hour posting window, the notice can show that original date instead. Explicit manual premiere dates support the same catch-up. Undated, regional-warning, unconfirmed expired and older premiere rows do not create an exact catch-up notice. The ordinary release posting window remains unchanged.

Late notices never advance the saved next episode or date. Moving an already known episode to a different date does not create a new introduction, and a regular dub post suppresses a redundant one. Successful delivery is saved per channel and included in backups, so failed channels alone are retried and restarts do not repeat the notice. There is at most one late introduction per series and language. Disabled series or language tracks do not post, and the automatic-post settings and test-server lock apply. Backup restore alone does not generate notices: a fresh source sync or save must recognize the late entry first. Late notices do not ping release roles.

Completed series remain in the `Finished` archive while their completion reminder is open. Manage confirmations separately in `Completion`: check `Completion handled` and click `Save` when you have handled a series. Open entries are protected from automatic deletion. After confirmation, entries remain for at least one more month; a later change to the total episode count can extend this period. Entries already deleted by an older version require a backup to restore.

### Completion Notices

One week after the stored completion time (`finishedAt`), the scheduler sends one individual Discord completion notice to the configured channels. It includes the series title, total episode count, selected streaming service, and completion date. Unknown episode totals or services are shown as `Unknown` instead of being guessed. Title, service ID and TVDB ID copy fields are included as in release posts. Completion notices do not ping release roles.

A series is complete only when the main release and all enabled language versions have finished. The individual notice is due seven calendar days later at the same local time in the configured timezone and is sent on the next scheduler tick. Release reminder settings do not shift it. No extra LiveChart requests are made for completion reminders.

After that individual notice, open entries are collected into one weekly Discord digest per configured channel. Choose its weekday and time in `Settings`; the default is Sunday at 18:00 in the configured timezone. The `Completion` tab shows the schedule and lets you manage open and handled entries. Check `Completion handled` to remove a series from future digests. Unchecking makes it eligible again for the next digest; it does not repeat the individual notice. This confirmation is separate from the release status `Finished`.

The digest contains only series whose individual notice was successfully delivered before that week's scheduled time. A notice sent at or after the digest time joins the following week, so a series does not get its first notice and a digest reminder together. The schedule keeps its local weekday and time across daylight-saving changes. If a list exceeds Discord's embed limits, the same message includes a text attachment with the complete list.

Successful delivery, weekly digest progress and the handled checkbox are included in JSON backups. Only failed channels are retried within a round, including after a restart; the next week starts a fresh round for all channels. Empty rounds send no message. After an outage, only the latest due digest is considered, without replaying missed weeks. Existing entries that received the old one-time notice join the digest while they remain open. Returning a series to an unfinished state, such as a later dub release, resets its confirmation and individual notice so its later completion starts afresh.

## Slash Commands

```text
/upcoming
```

Shows today and tomorrow.

```text
/shedule day
```

Shows releases for the selected weekday.

Commands are registered per guild when `DISCORD_CLIENT_ID` and `DISCORD_TOKEN` are configured. If `DISCORD_GUILD_ID` is empty, the bot registers commands in all guilds it can see.
