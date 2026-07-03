# Backup and Restore

Anime Sheduler stores its data in a JSON database. Backups are important before large imports, server moves, and major updates.

## Web Backup

Open `Settings` -> `Backup`.

- `Download backup` exports the complete Anime Sheduler database as JSON.
- `Restore backup` accepts an Anime Sheduler export or a raw `db.json` and replaces the current database.

Backups include:

- series
- language tracks
- finished states
- post logs
- selected Discord channels
- role settings
- scheduler and LiveChart settings

Backups do not include:

- `.env`
- Discord bot tokens
- Docker Compose files
- reverse proxy configuration

## Database Paths

Manual Node/systemd default:

```text
data/db.json
```

Manual systemd example:

```text
/var/lib/anime-sheduler/db.json
```

Docker path inside the container:

```text
/app/data/db.json
```

Docker Compose stores this in the `anime-sheduler-data` volume by default.

## Manual Backup Commands

Create a Docker backup:

```bash
docker compose exec -T anime-sheduler sh -c 'cat /app/data/db.json' > db-backup.json
```

Create a manual systemd backup:

```bash
sudo cp /var/lib/anime-sheduler/db.json \
  /var/lib/anime-sheduler/db-$(date +%F).json
```

## Moving Servers

1. On the old server, open `Settings` -> `Backup`.
2. Download a backup.
3. Install Anime Sheduler on the new server.
4. Copy your `.env` values manually. Do not put bot tokens into the database backup.
5. Start the new instance.
6. Open `Settings` -> `Backup`.
7. Restore the backup JSON.
8. Check `Settings` -> `Discord` and confirm selected channels still match the new bot/server access.

If the Discord bot is invited to the same servers, channel and role IDs usually continue to work.
