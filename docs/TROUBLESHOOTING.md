# Troubleshooting

## Web Panel Does Not Open

Docker:

```bash
docker compose ps
docker compose logs -f
```

Manual systemd:

```bash
sudo systemctl status anime-sheduler
sudo journalctl -u anime-sheduler -n 100
```

Health check:

```bash
curl http://127.0.0.1:3000/health
```

Expected output:

```json
{"ok":true}
```

## Discord Posts Do Not Appear

- Check `DISCORD_TOKEN`.
- Check the selected announcement channels in `Settings`.
- Check `DISCORD_CHANNEL_ID` if no channels are selected in the web panel.
- Make sure the bot has access to the channel.
- Make sure the bot can send messages.
- Check the logs.

## Slash Commands Do Not Appear

- Set `DISCORD_CLIENT_ID`.
- Restart the bot.
- Give Discord a short moment to show the guild slash command.
- If needed, set `DISCORD_GUILD_ID` to the target server ID.

## Automatic Posts Do Not Happen

- The series must be enabled.
- A release time must be set.
- `time missing` entries are posted at `MISSING_TIME_POST_TIME`.
- The Discord bot must be logged in.
- The configured Discord channel must be valid.

## LiveChart Stops Supplying Dates or New Titles

- LiveChart changed its schedule, language-list and season-card markup on October 31, 2026. Versions through `1.9.1` can stop finding season titles and clear German release dates during sync. Update to `1.9.2` or later, then run `Sync LiveChart now` to read the current dates again. The new-series check can be started separately in Settings, subject to its normal cooldown.
- The reader supports both the previous and current page structures. Pages without recognizable schedules fail the sync instead of replacing saved releases with empty data.
- A successfully read source can still have an undated or paused release. Such entries stay without a date; the scheduler does not invent a weekly date to fill the gap.
- Keep a backup before importing or restoring data. A corrected sync uses the current LiveChart schedule; it does not send announcements for every historical episode missed during the outage.
- Version `1.9.3` also recognizes local streaming, cinema and physical-media schedule categories without letting unrelated entries block valid German streaming dates. Future categories that cannot be read still fail safely.
- If `1.9.2` copied a total episode count from a related title, update to `1.9.3` and sync again. Counts now come from the current anime's own Episodes field. When that field explicitly has no announced total, a followed LiveChart entry returns to an unknown total instead of retaining the unrelated number. A failed detail-page read preserves the saved total; manual schedules are unchanged.
- Version `1.9.4` also ignores inapplicable regional rows during parser validation and recognizes combined Blu-ray/DVD and home-video categories. Incomplete language data on an applicable schedule still fails safely. A transient connection failure is retried once with the normal request delay; access denials, challenges and rate limits retain their existing pause.
- If the original series is finished but a dub remains open without a date, sync again with `1.9.4` or later. An explicit applicable `Released` source closes the language track and can create a one-time completion catch-up for missing announcements. An absent or paused dub does not close automatically.

## Security Notes

- Never commit `.env` or `/etc/anime-sheduler.env`.
- Set `WEB_PASSWORD` before exposing the panel publicly.
- Prefer HTTPS through a reverse proxy for public deployments.
- Do not expose Docker or Node management ports publicly.
- Back up `db.json` before major imports or server moves.
