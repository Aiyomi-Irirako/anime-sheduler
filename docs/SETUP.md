# Setup Guide

This guide covers Discord setup, environment configuration, Docker Compose, reverse proxy, and manual Node.js hosting.

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
- `DISCORD_CLIENT_ID`: Application ID. Required for slash commands.
- `DISCORD_GUILD_ID`: Optional comma-separated guild IDs. If empty, commands are registered in all guilds the bot can see.
- `DISCORD_CHANNEL_ID`: Optional fallback channel used before channels are selected in the web panel.
- `DISCORD_RELEASE_ROLE_ID`: Optional initial role ping for timed main release posts.
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

## Docker Compose

Docker Compose is the recommended production setup.

Clone the project:

```bash
git clone https://github.com/Aiyomi-Irirako/anime-sheduler.git
cd anime-sheduler
```

Create `.env`:

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

Start the bot:

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

Check status and logs:

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

Update:

```bash
git pull
docker compose up -d --build
```

Stop:

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

## Manual Node.js

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
