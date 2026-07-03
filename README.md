# Anime Sheduler

A self-hosted Discord bot with a web panel for weekly anime and series release schedules.

Import CSV data, edit release times, track language-specific episode numbers, sync selected data from LiveChart, and post upcoming releases to Discord.

Current version: `1.2.0`

## Features

- English web panel with light and dark theme
- CSV import through the web panel or CLI
- Editable title, streaming services, preferred posting service, weekday, time, manual next date, next episode, episode count, notes, and LiveChart link
- Episode ranges for multi-episode drops, for example `Episode 01-02`
- Optional image URL per series for Discord release thumbnails
- Multiple language versions per series, each with its own episode number
- Separate Discord posts for language versions with their own date and time
- Daily LiveChart sync for active and finished series with a LiveChart schedule link
- Automatic Discord announcements when an episode is due
- Multiple Discord announcement channels across multiple servers
- Optional Discord role mentions for timed main releases, language releases, and missing-time fallback posts
- Manual "Upcoming Episodes" Discord summary
- Discord slash commands: `/upcoming` for today/tomorrow and `/shedule day` for a selected weekday
- Optional Basic Auth protection for the web panel
- JSON data store, easy to back up and move between hosts
- Docker Compose support for simple self-hosting

## Get Started

You do not need a specific VPS provider or Debian-only setup.

Recommended install methods:

- Docker Compose: easiest self-hosting option for most users.
- Manual Node.js: useful if you prefer systemd, PM2, or another process manager.

There is no official hosted public instance included. This bot uses your own Discord bot token and is intended to run in your own environment.

## Requirements

For Docker:

- Docker Engine
- Docker Compose
- A Discord application and bot token
- A Discord text channel where the bot can post

For manual installation:

- Node.js 20 or newer
- pnpm or npm
- A process manager such as systemd, PM2, Docker, or another host runtime

## Discord Bot Setup

1. Open the Discord Developer Portal.
2. Create a new application.
3. Open `Bot`, create or reset the bot token, and copy it to `DISCORD_TOKEN`.
4. Open `OAuth2` -> `URL Generator`.
5. Select these scopes:
   - `bot`
   - `applications.commands`
6. Select at least these bot permissions:
   - `View Channels`
   - `Send Messages`
   - Optional: `Mention Everyone` if you want the bot to ping roles that are not normally mentionable
7. Open the generated invite URL and invite the bot to your server.
8. Enable Discord Developer Mode in your Discord client.
9. Optional: copy your server ID to `DISCORD_GUILD_ID` if you want to limit initial slash-command registration.
10. Optional: copy one target text channel ID to `DISCORD_CHANNEL_ID` as the initial fallback.
11. Copy the application ID to `DISCORD_CLIENT_ID`.

No privileged gateway intents are required.

## Configuration

Copy the example env file:

```bash
cp .env.example .env
```

Example:

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_application_id_here
DISCORD_GUILD_ID=your_server_id_here
DISCORD_CHANNEL_ID=your_channel_id_here
DISCORD_RELEASE_ROLE_ID=optional_release_role_id
DISCORD_LANGUAGE_ROLE_ID=optional_language_role_id
DISCORD_MISSING_TIME_ROLE_ID=optional_missing_time_role_id

WEB_PORT=3000
HOST_PORT=3000
WEB_USER=admin
WEB_PASSWORD=change-this-password

TIME_ZONE=Europe/Berlin
REMINDER_MINUTES=0
MISSING_TIME_POST_TIME=18:00
DATA_FILE=./data/db.json
```

Variable notes:

- `DISCORD_TOKEN`: Bot token from the Discord Developer Portal.
- `DISCORD_CLIENT_ID`: Application ID. Required for the `/upcoming` slash command.
- `DISCORD_GUILD_ID`: Optional comma-separated guild IDs. If empty, `/upcoming` is registered in all guilds the bot can see.
- `DISCORD_CHANNEL_ID`: Optional fallback channel used before channels are selected in the web panel.
- `DISCORD_RELEASE_ROLE_ID`: Optional initial role ping for timed main release posts. Roles can also be selected in the web panel.
- `DISCORD_LANGUAGE_ROLE_ID`: Optional initial role ping for timed language-version posts.
- `DISCORD_MISSING_TIME_ROLE_ID`: Optional initial role ping for missing-time fallback posts.
- `WEB_PORT`: Port used by the Node app. Docker keeps this at `3000` internally.
- `HOST_PORT`: Host port used by Docker Compose.
- `WEB_USER`: Basic Auth user for the web panel.
- `WEB_PASSWORD`: Basic Auth password. Set this before exposing the panel publicly.
- `TIME_ZONE`: Default timezone for release calculations.
- `REMINDER_MINUTES`: `0` posts at release time, `60` posts one hour before release time.
- `MISSING_TIME_POST_TIME`: Fallback auto-post time for releases whose exact time is unknown.
- `DATA_FILE`: Path to the JSON database. Docker Compose overrides this to `/app/data/db.json`.

## Self-Host with Docker Compose

Docker Compose is the recommended production setup.

### 1. Clone the project

```bash
git clone https://github.com/Aiyomi-Irirako/anime-sheduler.git
cd anime-sheduler
```

If you downloaded a ZIP instead, extract it and open the project folder.

### 2. Create `.env`

```bash
cp .env.example .env
nano .env
```

Fill in at least:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
WEB_PASSWORD=
```

`DISCORD_GUILD_ID` and `DISCORD_CHANNEL_ID` are optional. Channels can be selected later in the web panel.

### 3. Start the bot

```bash
docker compose up -d --build
```

Open:

```text
http://localhost:3000
```

If you set `HOST_PORT=8080`, open:

```text
http://localhost:8080
```

### 4. Check status and logs

```bash
docker compose ps
docker compose logs -f
```

Health check:

```bash
curl http://127.0.0.1:3000/health
```

Expected output:

```json
{"ok":true}
```

### 5. Update

```bash
git pull
docker compose up -d --build
```

### 6. Stop

```bash
docker compose down
```

Your data stays in the Docker volume `anime-sheduler-data`.

## Reverse Proxy

For public access, put the bot behind a reverse proxy and enable HTTPS.

Example Nginx config:

```nginx
server {
    listen 80;
    server_name anime.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

After your domain points to the server, you can add HTTPS with Certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d anime.example.com
```

Keep `WEB_PASSWORD` set when the web panel is reachable from the internet.

## Manual Node.js Installation

Use this if you do not want Docker.

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm start
```

Open:

```text
http://localhost:3000
```

npm also works:

```bash
npm install
npm start
```

## Debian systemd Example

This is an optional manual deployment example. Docker users can skip it.

Recommended layout:

```text
/opt/anime-sheduler        app files
/var/lib/anime-sheduler    database
/etc/anime-sheduler.env    secrets and runtime config
```

Create a system user:

```bash
sudo useradd --system --home /opt/anime-sheduler --shell /usr/sbin/nologin animesheduler
sudo mkdir -p /opt/anime-sheduler /var/lib/anime-sheduler
sudo chown -R animesheduler:animesheduler /opt/anime-sheduler /var/lib/anime-sheduler
```

Clone and install:

```bash
sudo -u animesheduler git clone https://github.com/Aiyomi-Irirako/anime-sheduler.git /opt/anime-sheduler
cd /opt/anime-sheduler
sudo corepack enable
sudo -u animesheduler pnpm install --prod --frozen-lockfile
```

Create `/etc/anime-sheduler.env`:

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_application_id_here
DISCORD_GUILD_ID=your_server_id_here
DISCORD_CHANNEL_ID=your_channel_id_here

WEB_PORT=3000
WEB_USER=admin
WEB_PASSWORD=change-this-password

TIME_ZONE=Europe/Berlin
REMINDER_MINUTES=0
MISSING_TIME_POST_TIME=18:00
DATA_FILE=/var/lib/anime-sheduler/db.json
```

Secure it:

```bash
sudo chown root:animesheduler /etc/anime-sheduler.env
sudo chmod 640 /etc/anime-sheduler.env
```

Create `/etc/systemd/system/anime-sheduler.service`:

```ini
[Unit]
Description=Anime Sheduler
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=animesheduler
Group=animesheduler
WorkingDirectory=/opt/anime-sheduler
Environment=NODE_ENV=production
EnvironmentFile=/etc/anime-sheduler.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/anime-sheduler

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now anime-sheduler
sudo systemctl status anime-sheduler
```

Logs:

```bash
sudo journalctl -u anime-sheduler -f
```

Update:

```bash
cd /opt/anime-sheduler
sudo -u animesheduler git pull
sudo -u animesheduler pnpm install --prod --frozen-lockfile
sudo systemctl restart anime-sheduler
```

## CSV Import

Use the web panel:

1. Open `Settings`.
2. Paste your CSV into `CSV Import`.
3. Keep `Update existing series` enabled.
4. Enable `Overwrite schedule and episodes from CSV` only when you intentionally want CSV data to replace manual edits.

CLI import:

```bash
pnpm run import -- /path/to/summer-2026.csv
```

Docker CLI import:

```bash
docker compose cp ./summer-2026.csv anime-sheduler:/tmp/summer-2026.csv
docker compose exec anime-sheduler pnpm run import -- /tmp/summer-2026.csv
```

For Docker, the web import is usually easier because you can paste the CSV directly.

## Editing Releases

- `Release day` and `Time`: normal weekly schedule.
- `Next date`: manual override for a delayed or moved episode.
- `Episodes this release`: set this to `2` or higher when a service releases multiple episodes at once. The Discord post uses a range like `Episode 01-02`, then advances to the next episode and resets this field to `1`.
- `Language Versions`: enable additional language versions and set their next episode numbers.
- Language version schedules: each enabled language can have its own weekday, time, or manual next date.
- `Auto-enabled languages`: global settings for language versions found by LiveChart.
- `LiveChart sync`: updates a single series from its LiveChart schedule link.
- LiveChart language times: when LiveChart exposes a timestamp for a language version, the bot stores it as that language's next date and release time.
- `Image URL`: optional poster/cover image used as a small Discord thumbnail. LiveChart sync can fill this automatically when available.
- `Discord announcement channels`: select one or more text channels from any server the bot can access. Release posts are sent to every selected channel.
- `Discord role mentions`: select roles for timed main releases, language releases, and missing-time fallback posts. If the bot posts to multiple servers, select the matching role in each server.
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

Slash command:

```text
/upcoming
```

This command is registered per guild when `DISCORD_CLIENT_ID` and `DISCORD_TOKEN` are configured. If `DISCORD_GUILD_ID` is empty, the bot registers it in all guilds it can see.

## Backups

The important file is the JSON database.

Manual Node/systemd path:

```text
data/db.json
```

or:

```text
/var/lib/anime-sheduler/db.json
```

Docker path inside the container:

```text
/app/data/db.json
```

Create a Docker backup:

```bash
docker compose exec -T anime-sheduler sh -c 'cat /app/data/db.json' > db-backup.json
```

Create a manual systemd backup:

```bash
sudo cp /var/lib/anime-sheduler/db.json \
  /var/lib/anime-sheduler/db-$(date +%F).json
```

Back up `db.json` before large imports, server moves, or major updates.

## Troubleshooting

### Web panel does not open

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

### Discord posts do not appear

- Check `DISCORD_TOKEN`.
- Check the selected announcement channels in `Settings`.
- Check `DISCORD_CHANNEL_ID` if no channels are selected in the web panel.
- Make sure the bot has access to the channel.
- Make sure the bot can send messages.
- Check the logs.

### `/upcoming` does not appear

- Set `DISCORD_CLIENT_ID`.
- Set `DISCORD_CLIENT_ID`.
- Restart the bot.
- Give Discord a short moment to show the guild slash command.

### Automatic posts do not happen

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
