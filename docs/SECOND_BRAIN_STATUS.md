# Second-Brain Status

WebsiteCritique is an active project, not an archived project.

## Why This Note Exists

On 2026-07-02, the live URL `https://portal.glenfarrell.net/WebsiteCritique/` was rediscovered after earlier records pointed mainly to an archived local Claude project folder:

```text
PROJECTS/Website Strategy Executive Critique/STATE.md
```

That created a false impression that the project had been retired. The actual service is live on Cloak and managed by launchd.

## Current Truth

- Active URL: https://portal.glenfarrell.net/WebsiteCritique/
- Runtime: Cloak
- Runtime path: `/Users/gia/claude-automations/website-critique`
- LaunchAgent: `com.glenfarrell.website-critique`
- Source-of-truth repo: `/Users/glenfarrell/Documents/GitHub/website-critique`
- GitHub repo: https://github.com/glenfarrell-cloak/website-critique
- Notion active registry: https://app.notion.com/p/391d15a4886c8100a8a8fd1438782171

## Analyzer Correction Status

On 2026-07-02, the Modern Consulting Group self-review mismatch was fixed and validated. The analyzer now renders JavaScript-driven sites, detects observed CTAs before scoring, and corrects absolute missing-CTA claims when booking evidence is present.

For `https://modernconsultinggroup.com`, production validation detected:

- `Book a Call [nav]`
- `Book a 15-Minute Call [section]`
- `Book a 15-Min Builder Chat [section]`
- `Request a Sample [section]`
- `Book a 15-Min Strategy Call [section]`

The corrected critique is `Conversion Path Needs Stronger Qualification`, not `No Conversion Path or Lead Mechanism`.

## Cleanup Rule

When future cleanup, archive, or second-brain consolidation work encounters:

- `WebsiteCritique`
- `Website Critique Portal`
- `Website Strategy Executive Critique`
- `portal.glenfarrell.net/WebsiteCritique/`

the project should be classified as an active production service unless the live URL, Cloak LaunchAgent, and source repository are all explicitly retired.
