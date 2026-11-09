# Tandem

**AI coworkers that run on your computer.** Bots sign in to your apps, use them the way you
do, and come back with the job done. Free and open source. Bots run on the Claude Code plan
you already have.

**Website:** https://tandem-c6l.pages.dev

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/NeilGilani/tandem/main/install.sh | bash
```

The installer downloads Tandem to `~/tandem`, sets it to run in the background and start at
login, and opens http://127.0.0.1:4747.

Requirements: macOS, Node 22.13+, Google Chrome (or Chromium, Edge or Brave), and
[Claude Code](https://claude.com/claude-code) installed and signed in (`claude` on your PATH).

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
| One shared cloud computer | One shared computer: the `data/computer/workspace` folder, one Chrome profile (`data/computer/chrome-profile`) and this Mac's command line |
| Bots use apps the way a person does | Playwright MCP drives that Chrome over CDP, and sign-ins are shared by all Bots |
| Take over / I'm done | Computer panel: watch live, Take control (click and type from any device), or Take over in the real window, then press I'm done |
| Connect apps | 70+ apps: Google, Microsoft (Outlook, Teams, OneDrive, SharePoint, Office), Slack, Notion, Linear, Jira, Salesforce, HubSpot, LinkedIn, GitHub, Stripe and more, plus Mac Calendar, Contacts, Reminders and Messages, plus any MCP server as a custom app |
| Vault and 1Password fill | Vault stores values in your macOS Keychain. `vault_fill_login` fills sign-in forms and the Bot never sees the values |
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

- **The computer is your Mac, not a cloud machine.** Bots run while the Mac is awake and Tandem is running. Use `bin/tandem install` so Tandem starts at login.
- **Connectors use browser sign-ins.** Tandem doesn't have OAuth apps registered with Google, Microsoft or others, so apps are used through the shared browser, the same way Grok Bot uses apps that have no API connector. For an API-level connector, add that service's MCP server as a custom app.
- **No hosted Bot email address.** Bots use your connected Gmail or Outlook instead.
- **Webhooks only reach this Mac.** For GitHub, Linear, Sentry or PagerDuty to call a routine's webhook from the internet, expose port 4747 with a tunnel such as Tailscale Funnel or Cloudflare Tunnel.
- **No image generation for avatars.** Use a shape and color, or upload an image.
- **No team features.** Shared Bots, publishing templates and admin rules aren't included.

## Usage and terms

Every Bot turn, routine run and test run uses your Claude plan's limits. Tandem is for your own
use on your own subscription. Don't run Bots for other people on it; that needs an API key.

## Layout

```
server/   daemon: HTTP API, events, engine (Claude Code runs), approvals, routines, connectors, vault, Mac apps
mcp/      the per-run MCP bridge that gives Bots the Tandem tools
web/      the app (no build step)
data/     everything you create (gitignored): database, memory, skills, uploads, computer
```
