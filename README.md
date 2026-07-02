# WebsiteCritique

Active production project for the Modern Consulting Group executive website review funnel.

## Current Status

- Status: active live service
- Public URL: https://portal.glenfarrell.net/WebsiteCritique/
- Runtime host: Cloak
- Runtime path: `/Users/gia/claude-automations/website-critique`
- GitHub repo: https://github.com/glenfarrell-cloak/website-critique
- Process manager: launchd
- LaunchAgent: `/Users/gia/Library/LaunchAgents/com.glenfarrell.website-critique.plist`
- Service label: `com.glenfarrell.website-critique`
- Local service port on Cloak: `8081`
- Notion active registry: https://app.notion.com/p/391d15a4886c8100a8a8fd1438782171

This project was previously mistaken for an archived Claude workspace because the old planning/source notes were moved into the June 2026 local cleanup archive after the Cloak migration closeout. The live service itself remained active on Cloak. Treat this GitHub repository as the source-of-truth going forward.

## What It Does

WebsiteCritique is a Node/Express single-page app that:

- collects a website URL plus brief client context
- fetches the submitted website
- generates an executive-grade website and positioning review through Anthropic
- stores generated submissions in `data/submissions.json`
- emails the report through Resend
- exposes report pages at `/WebsiteCritique/report/:id`

## Repository Scope

Tracked source:

- `server.js`
- `package.json`
- `package-lock.json`
- documentation and operations notes

Not tracked:

- `.env` secrets
- `data/submissions.json` customer/runtime data
- `logs/`
- `node_modules/`

## Local Development

```sh
npm install
cp .env.example .env
npm run dev
```

Then open:

```text
http://localhost:8081/WebsiteCritique/
```

The analyze endpoint requires valid `ANTHROPIC_API_KEY` and `RESEND_API_KEY` values.

## Production Health Checks

```sh
curl -I https://portal.glenfarrell.net/WebsiteCritique/
curl https://portal.glenfarrell.net/WebsiteCritique/status
ssh gia@cloak.local 'launchctl print gui/$(id -u)/com.glenfarrell.website-critique | sed -n "1,80p"'
```

## Recovery Note

If future cleanup tools see archived notes for `PROJECTS/Website Strategy Executive Critique`, do not infer the project is retired. The canonical live project is WebsiteCritique, backed by this repository and the Cloak launchd service above.
