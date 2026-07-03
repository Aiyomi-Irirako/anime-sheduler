# Windows Server Guide

Anime Sheduler can run on Windows Server with Node.js. Docker or Linux VPS hosting is usually simpler for production, but Windows works well for a small self-hosted bot.

## Recommended Layout

```text
C:\anime-sheduler          app files
C:\anime-sheduler\data     JSON database
C:\anime-sheduler\logs     optional service logs
C:\anime-sheduler\.env     secrets and runtime config
```

Do not commit or share `.env`.

## Install Requirements

Open PowerShell as Administrator.

Install Git and Node.js 20 LTS:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
```

Close and reopen PowerShell so `git` and `node` are on the PATH.

Enable pnpm through Corepack:

```powershell
corepack enable
corepack prepare pnpm@9.15.9 --activate
```

Check versions:

```powershell
node --version
pnpm --version
git --version
```

## Install Anime Sheduler

Clone the project:

```powershell
git clone https://github.com/Aiyomi-Irirako/anime-sheduler.git C:\anime-sheduler
Set-Location C:\anime-sheduler
```

Install dependencies:

```powershell
pnpm install --frozen-lockfile
```

Create `.env`:

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill in at least:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
WEB_PASSWORD=
DATA_FILE=./data/db.json
```

`DISCORD_GUILD_ID` and `DISCORD_CHANNEL_ID` are optional. Channels can be selected later in the web panel.

## Test Run

Start the bot manually:

```powershell
pnpm start
```

Open:

```text
http://localhost:3000
```

Stop the manual run with `Ctrl+C`.

## Windows Firewall

If you only use the panel from the same server, no firewall rule is needed.

For LAN or public access on port `3000`, add a rule:

```powershell
New-NetFirewallRule -DisplayName "Anime Sheduler Web Panel" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

Keep `WEB_PASSWORD` set before exposing the panel outside localhost. For public access, use HTTPS through a reverse proxy.

## Run on Startup with NSSM

For a long-running Windows service, NSSM is the most convenient option. Download NSSM, extract it, and adjust the path below to your `nssm.exe`.

Create a log folder:

```powershell
New-Item -ItemType Directory -Force C:\anime-sheduler\logs
```

Find the Node.js path:

```powershell
where.exe node
```

Install and start the service:

```powershell
$nssm = "C:\tools\nssm\nssm.exe"
$node = "C:\Program Files\nodejs\node.exe"

& $nssm install AnimeSheduler $node "src\index.js"
& $nssm set AnimeSheduler AppDirectory "C:\anime-sheduler"
& $nssm set AnimeSheduler AppEnvironmentExtra NODE_ENV=production
& $nssm set AnimeSheduler AppStdout "C:\anime-sheduler\logs\service.log"
& $nssm set AnimeSheduler AppStderr "C:\anime-sheduler\logs\service.err.log"
& $nssm set AnimeSheduler AppRotateFiles 1
& $nssm set AnimeSheduler AppRotateOnline 1
& $nssm set AnimeSheduler AppRotateBytes 1048576
& $nssm start AnimeSheduler
```

Check service status:

```powershell
& $nssm status AnimeSheduler
Get-Content C:\anime-sheduler\logs\service.log -Tail 50
Get-Content C:\anime-sheduler\logs\service.err.log -Tail 50
```

Restart or stop:

```powershell
& $nssm restart AnimeSheduler
& $nssm stop AnimeSheduler
```

Remove the service:

```powershell
& $nssm remove AnimeSheduler confirm
```

## Alternative: Task Scheduler

Task Scheduler also works, but logs and restarts are less comfortable than with NSSM.

Create a startup task:

```powershell
$node = (Get-Command node).Source
$project = "C:\anime-sheduler"
$action = New-ScheduledTaskAction -Execute $node -Argument "src\index.js" -WorkingDirectory $project
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName "Anime Sheduler" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest
Start-ScheduledTask -TaskName "Anime Sheduler"
```

Remove it:

```powershell
Unregister-ScheduledTask -TaskName "Anime Sheduler" -Confirm:$false
```

## Update on Windows

If you run NSSM:

```powershell
$nssm = "C:\tools\nssm\nssm.exe"
& $nssm stop AnimeSheduler
Set-Location C:\anime-sheduler
git pull
pnpm install --prod --frozen-lockfile
& $nssm start AnimeSheduler
```

If you run manually:

```powershell
Set-Location C:\anime-sheduler
git pull
pnpm install --frozen-lockfile
pnpm start
```

## Backup on Windows

The easiest option is the web panel:

1. Open `Settings`.
2. Open `Backup`.
3. Click `Download backup`.

Manual file backup:

```powershell
Set-Location C:\anime-sheduler
Copy-Item .\data\db.json ".\data\db-$(Get-Date -Format yyyy-MM-dd).json"
```

The backup does not include `.env`, so keep your Discord token and web password separately.

## Common Windows Checks

Check the process:

```powershell
Get-Process node -ErrorAction SilentlyContinue
```

Check the web panel:

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:3000/health
```

Check whether port `3000` is listening:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen
```
