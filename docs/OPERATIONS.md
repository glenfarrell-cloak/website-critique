# WebsiteCritique Operations

## Canonical Identity

- Project name: WebsiteCritique
- Business surface: Modern Consulting Group executive website review
- Live URL: https://portal.glenfarrell.net/WebsiteCritique/
- Notion closeout breadcrumb: `Closeout - Website Critique Portal Migration to Cloak`
- Legacy planning folder: `PROJECTS/Website Strategy Executive Critique`

## Production Runtime

Production runs on Cloak under the `gia` account:

```text
/Users/gia/claude-automations/website-critique
```

The launchd service is:

```text
com.glenfarrell.website-critique
```

The LaunchAgent is:

```text
/Users/gia/Library/LaunchAgents/com.glenfarrell.website-critique.plist
```

Current service command:

```text
/opt/homebrew/bin/node /Users/gia/claude-automations/website-critique/server.js
```

## Verify Production

```sh
curl -I https://portal.glenfarrell.net/WebsiteCritique/
curl https://portal.glenfarrell.net/WebsiteCritique/status
ssh gia@cloak.local 'launchctl print gui/$(id -u)/com.glenfarrell.website-critique | sed -n "1,120p"'
ssh gia@cloak.local 'tail -80 /Users/gia/claude-automations/website-critique/logs/stdout.log'
ssh gia@cloak.local 'tail -80 /Users/gia/claude-automations/website-critique/logs/stderr.log'
```

## Runtime Data

Submissions are stored on Cloak in:

```text
/Users/gia/claude-automations/website-critique/data/submissions.json
```

Do not commit this file. It can contain customer names, emails, websites, and generated reports.

## Secrets

Production secrets live in the Cloak `.env` file beside the runtime service. Do not copy it into this repo.

Required variables are documented in `.env.example`.

## Deployment Shape

This service currently runs as a Cloak launchd-managed Node process. Cloudflare/portal routing exposes it at:

```text
https://portal.glenfarrell.net/WebsiteCritique/
```

Do not archive or remove this project solely because old Claude project notes are in a cleanup quarantine/archive folder. Archive status of those notes does not equal runtime status.

## If Moving To A Different Route

A prior design note considered replacing path-based portal routes with per-service subdomains. That redesign was deferred. Until it is explicitly implemented and verified, the active route remains:

```text
https://portal.glenfarrell.net/WebsiteCritique/
```

## GitHub Publication Status

Local Git is initialized and committed. Remote GitHub publication is pending because `glenfarrell/website-critique` does not exist yet, and this environment has no `gh`/`hub` CLI or GitHub token available to create a repository. Once the repo exists, push with:

```sh
git remote add origin git@github.com:<owner>/website-critique.git
git push -u origin main
```
