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
- Duplicate protection applies to manual saves, CSV imports and automatic discovery. LiveChart URL variants for the same anime and matching MAL IDs identify the same series; otherwise normalized exact titles are compared unless both entries have different source IDs. Separate seasons are not matched by fuzzy title rules. Manual duplicates open the existing entry without overwriting it. Older duplicates in backups are not silently deleted.
- `Release day` and `Time`: normal weekly schedule.
- `Next date`: manual override for a delayed or moved episode.
- `Episodes this release`: set this to `2` or higher when a service releases multiple episodes at once. The Discord post uses a range like `Episode 01-02/12` when the total is known, then advances to the next episode and resets this field to `1`.
- `Language Versions`: enable additional language versions and set their next episode numbers.
- Language version schedules: each enabled language can have its own weekday, time, or manual next date.
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
- Missing time: the panel shows `time missing`, and the scheduler posts it at `MISSING_TIME_POST_TIME`.

The global LiveChart sync intentionally waits between requests to reduce the chance of rate limits.

## Changelog

Open `Changelog` in the top navigation to review series changes from the last 7 days. The list includes manual edits, CSV imports, LiveChart sync updates, scheduler advances after Discord posts, and deleted entries. Older entries are removed automatically.

## Discord Posting

The scheduler runs continuously while the bot is active.

### Test Servers

Disable `Automatic Discord posts` under `Settings > Discord` to keep Discord connected without automatic episode, dub, missing-time or completion announcements. LiveChart sync and new-series checks continue normally. Manual test posts, manual summaries and slash commands remain available and can still send messages to the selected channels. Paused automatic posts do not advance episodes or mark notifications as delivered.

For a dedicated test instance, set `DISCORD_AUTO_POSTS=false` in its `.env` before starting it. This server-level lock overrides the saved checkbox, including after restoring a production backup. Restart the app after changing the environment setting (recreate the container with `docker compose up -d --force-recreate` for Docker). The web panel displays the lock. Leave this variable unset or set to `true` on production to preserve normal automatic posting. In-flight Discord requests cannot be recalled; disabling automatic posts stops subsequent scheduler sends. Re-enabling can send releases still within the normal posting window and overdue completion notices.

### Automatic Releases

Before an automatic post is sent for a LiveChart-linked series, the scheduler refreshes that single series from LiveChart and recalculates whether it is still due. If LiveChart moved the episode, the stale post is skipped and the stored entry is updated. If LiveChart replaces the final episode with `Released`, a known, unposted final episode remains eligible within the six-hour posting window. This also applies when a daily sync runs before the scheduler.

If `REMINDER_MINUTES=0`, the bot posts at release time.

If `REMINDER_MINUTES=60`, the bot posts one hour before release time.

If a release has no exact time, the bot posts it at `MISSING_TIME_POST_TIME`. The default is `18:00`.

Automatic release posts and manual series test posts can ping selected Discord roles. Summary posts do not ping those roles.

Release embeds include compact plain-text copy fields for the base anime title and, when entered, its streaming service ID. Trailing labels such as specials, seasons, parts, and cours are omitted from the title field without changing the stored or displayed series title.

Episode fields include the known total, for example `Episode 05/12`, `Episode 05-06/12`, or `Episode 03/12 (German)`. Schedule summaries and the web panel also show totals. Discord embed headings keep the current episode without the total. When the total is unknown, the label stays as `Episode 05` without a guessed denominator. Copy fields contain only the title or service ID, not episode information.

The default release description distinguishes new original episodes, dub episodes, and combined releases. For example, a combined original/German release says `New original and German dub episodes are available now.` A custom series note or the missing-time fallback description still takes precedence.

After an automatic post, only the release that was posted is advanced. Main episodes and language versions are tracked separately.

Completed series remain in `Finished` for at least one month after all tracked releases finish. A later change to the total episode count restarts the one-month retention period. Episode totals announced before completion do not shorten this period. Entries already deleted by an older version require a backup to restore.

### Completion Notices

One week after the stored completion time (`finishedAt`), the scheduler sends a one-time Discord notice to the configured channels. The notice includes the series title, total episode count, selected streaming service, and completion date. Unknown episode totals or services are shown as `Unknown` instead of being guessed. Title and service ID copy fields are included as in release posts. Completion notices do not ping release roles.

A series is complete only when the main release and all enabled language versions have finished. The notice is due seven calendar days later at the same local time in the configured timezone and is sent on the next scheduler tick. Release reminder settings do not shift it. Existing finished entries are eligible too; overdue notices are sent while the entry is still retained, including after a restart or a Discord outage. No extra LiveChart requests are made for these notices.

Successful delivery is stored with the series and included in JSON backups. If delivery fails in some channels, only those channels are retried. Returning a series to an unfinished state resets its completion notice, so a later completion starts a new week. The existing one-month cleanup policy is unchanged.

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
