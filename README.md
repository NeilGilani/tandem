# Tandem

**AI coworkers that run on your computer.** Bots sign in to your apps, use them the way you
do, and come back with the job done. Free and open source. Bots run on the Claude Code plan
you already have.

**Website:** https://tandem-c6l.pages.dev

## Install

**Mac app:** download [Tandem-mac.zip](https://github.com/NeilGilani/tandem/releases/latest/download/Tandem-mac.zip),
unzip it, and drag Tandem to Applications. It's for Apple silicon and macOS 13 or later, and it bundles its own Node.
The app isn't notarized yet, so the first time you open it, right-click Tandem and choose **Open**.
It lives in the menu bar and keeps your Bots working after you close the window.

**Windows:** in PowerShell:

```powershell
irm https://raw.githubusercontent.com/NeilGilani/tandem/main/install.ps1 | iex
```

It downloads Tandem to `~\tandem`, runs it in the background, starts it when you sign in, and opens
http://127.0.0.1:4747. For a tray app with its own window (and its own Node), build `Tandem.exe`; see
[Build the Windows app](#build-the-windows-app).

**Or on a Mac with Terminal:**

```bash
curl -fsSL https://raw.githubusercontent.com/NeilGilani/tandem/main/install.sh | bash
```

The installer downloads Tandem to `~/tandem`, sets it to run in the background and start at
login, and opens http://127.0.0.1:4747.

Requirements: macOS or Windows 10/11, Node 22.13+, Google Chrome (or Chromium, Edge or Brave), and
[Claude Code](https://claude.com/claude-code) installed and signed in (`claude` on your PATH). On Windows,
Claude Code also needs [Git for Windows](https://git-scm.com/download/win), and the launcher is `bin\tandem.cmd`.

```bash
tandem open | status | logs | uninstall
tandem start              # run in the foreground instead
tandem install --lan      # also reachable from your phone on the same network
```

If you like it, [star the repo](https://github.com/NeilGilani/tandem).

## How it works

| Feature | How Tandem does it |
|---|---|
| Named Bots you message like coworkers | Each Bot keeps its own Claude Code session per conversation (`claude -p --resume`) |
| A computer for the Bots | **Each Bot gets its own computer**: its own Chrome profile (so its own sign-ins) and its own folder under `data/computers/<bot>/`, plus a `data/shared` folder every Bot can use to hand files to each other. Browsers start when a Bot starts work, stay minimized, and close after 15 idle minutes |
| Bots use apps the way a person does | Playwright MCP drives the Bot's own Chrome over CDP. You sign in per Bot in Connect apps |
| Take over / I'm done | Computer panel: watch live, Take control (click and type from any device), or Take over in the real window, then press I'm done |
| Connect apps | 70+ apps: Google, Microsoft (Outlook, Teams, OneDrive, SharePoint, Office), Slack, Notion, Linear, Jira, Salesforce, HubSpot, LinkedIn, GitHub, Stripe and more, plus Mac Calendar, Contacts, Reminders and Messages, plus any MCP server as a custom app |
| Vault and 1Password fill | Vault stores values in your macOS Keychain (on Windows, in a file encrypted for your Windows account with DPAPI). `vault_fill_login` fills sign-in forms and the Bot never sees the values |
| Approvals and Auto Review | Claude Code's permission prompt tool runs every non-read-only action through built-in safety checks and your Custom Rules. Cards offer Allow once, Always allow and Deny. Background cards expire after 30 minutes |
| Execution on this computer | Ask every time / Always allow / Never allow, for shell commands |
| Drafts | Outgoing email, Slack and Teams messages appear as draft cards with Send and Discard. Drafts can be turned off per Bot |
| Memory | Per-Bot facts and a work log. Facts about you are shared by all Bots. Memory import goes to your primary Bot |
| Skills and Teach a task | A shared skill library (`data/skills/*/SKILL.md`), switched on or off per Bot. Teach mode records screenshots for up to 10 minutes, then Claude drafts the skill |
| Routines | Plain-language schedules ("weekdays at 8am") or webhooks. Test, Pause, Run history (20 records), and the same limits as Grok Bot: 50 routines per Bot, at least 5 minutes apart, 300 runs/hour |
| Group chats and @mentions | Groups of 2 to 6 Bots, with @Bot, @everyone, and automatic choice of who responds |
| Bot-to-Bot handoff | `message_bot`: the other Bot wakes up, does the work and replies back. The handoff is visible in both chats |
| Automatic model routing | Each turn goes to Haiku, Sonnet or Opus depending on the task. There is no model picker |
| Desktop and phone | Installable web app (PWA). `--lan` plus the link in Settings → Devices signs a phone in |
| Templates | Chief of Staff, Inbox Manager, Sales Outbound, Talent Scout, Paid Media and more |

### Limits of running locally

- **The computer is your Mac or PC, not a cloud machine.** Bots run while it is awake and Tandem is running. Use `bin/tandem install` (`bin\tandem.cmd install` on Windows) so Tandem starts at login.
- **Connectors use browser sign-ins.** Tandem doesn't have OAuth apps registered with Google, Microsoft or others, so apps are used through the shared browser, the same way Grok Bot uses apps that have no API connector. For an API-level connector, add that service's MCP server as a custom app.
- **No hosted Bot email address.** Bots use your connected Gmail or Outlook instead.
- **Webhooks only reach this Mac.** For GitHub, Linear, Sentry or PagerDuty to call a routine's webhook from the internet, expose port 4747 with a tunnel such as Tailscale Funnel or Cloudflare Tunnel.
- **No image generation for avatars.** Use a shape and color, or upload an image.
- **No team features.** Shared Bots, publishing templates and admin rules aren't included.

## Usage and terms

Every Bot turn, routine run and test run uses your Claude plan's limits. Tandem is for your own
use on your own subscription. Don't run Bots for other people on it; that needs an API key.

**Sharing with a cofounder:** Settings → Team. Add a teammate to get their own sign-in link
(revocable on its own). Their requests carry their name and the Bots' questions go to them; only you
can send from your accounts, connect apps, see saved logins or change settings. Switch "Who pays
for Bot work" to a company Anthropic API key first. Turn on "Let teammates connect" (or run `tandem install --lan`)
plus Tailscale; never expose it to the public internet.

### On Windows

- Bots use a browser on your PC. The window is parked off-screen while a Bot works; Take over brings it back.
- Mac apps (Calendar, Contacts, Reminders, Messages) and the Linux laptops aren't available. Notifications are.
- Bots' shell commands run in Git Bash, the way Claude Code runs them on Windows.

## Build the Windows app

```powershell
windows\build.ps1 -Open    # -> dist\Tandem\Tandem.exe and dist\Tandem-win.zip
```

It uses the C# compiler that ships with Windows, so there is nothing to install. The app lives in the
tray, keeps the server running, and opens Tandem in its own Edge or Chrome window. `-NoNode` skips
bundling Node. Build from a short path such as `C:\src\tandem`; Windows tools still trip on very long ones.

## Build the Mac app

```bash
macos/build.sh --open     # → dist/Tandem.app and dist/Tandem-mac.zip
```

## Layout

```
server/   daemon: HTTP API, events, engine (Claude Code runs), approvals, routines, connectors, vault, Mac apps
mcp/      the per-run MCP bridge that gives Bots the Tandem tools
web/      the app (no build step)
macos/    the native Mac app (Swift): window, menu bar, notifications, bundled Node
windows/  the Windows tray app (C#): keeps the server running, opens the app window, bundled Node
data/     everything you create (gitignored): database, memory, skills, uploads, computer
```
