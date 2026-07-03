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

## Editing Releases

- `Release day` and `Time`: normal weekly schedule.
- `Next date`: manual override for a delayed or moved episode.
- `Episodes this release`: set this to `2` or higher when a service releases multiple episodes at once. The Discord post uses a range like `Episode 01-02`, then advances to the next episode and resets this field to `1`.
- `Language Versions`: enable additional language versions and set their next episode numbers.
- Language version schedules: each enabled language can have its own weekday, time, or manual next date.
- `Auto-enabled languages`: global settings for language versions found by LiveChart.
- `LiveChart sync`: updates a single series from its LiveChart schedule link.
- LiveChart language times: when LiveChart exposes a timestamp for a language version, the bot stores it as that language's next date and release time.
- `Image URL`: optional poster or cover image used as a small Discord thumbnail. LiveChart sync can fill this automatically when available.
- `Discord announcement channels`: open a server section, then select one or more text channels the bot can access. Release posts are sent to every selected channel.
- `Discord role mentions`: open a server section and select roles for timed main releases, language releases, and missing-time fallback posts. If the bot posts to multiple servers, select the matching role in each server.
- `Sync LiveChart now`: updates all active series that have a LiveChart link.
- `Update from LiveChart once per day`: runs one slow daily sync at the configured hour.
- `Continue weekly`: moves a manual `Next date` forward by 7 days after a post.
- Missing time: the panel shows `time missing`, and the scheduler posts it at `MISSING_TIME_POST_TIME`.

The global LiveChart sync intentionally waits between requests to reduce the chance of rate limits.

## Discord Posting

The scheduler runs continuously while the bot is active.

If `REMINDER_MINUTES=0`, the bot posts at release time.

If `REMINDER_MINUTES=60`, the bot posts one hour before release time.

If a release has no exact time, the bot posts it at `MISSING_TIME_POST_TIME`. The default is `18:00`.

Automatic release posts and manual series test posts can ping selected Discord roles. Summary posts do not ping those roles.

After an automatic post, only the release that was posted is advanced. Main episodes and language versions are tracked separately.

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
