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

## Security Notes

- Never commit `.env` or `/etc/anime-sheduler.env`.
- Set `WEB_PASSWORD` before exposing the panel publicly.
- Prefer HTTPS through a reverse proxy for public deployments.
- Do not expose Docker or Node management ports publicly.
- Back up `db.json` before major imports or server moves.
