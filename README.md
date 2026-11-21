# Ship Context

A Forge app for Jira that answers the question every release owner gets asked:
*is this version actually going to ship?*

Ship Context analyses a Jira fix version end-to-end — every issue in it, the
links between them, their recency, estimates and priorities — and turns it into
a readiness score (0–100), a concrete risk list, and recommended next actions.
The same analysis powers three surfaces:

- **Release readiness dashboard** — a Jira global page (`jira:globalPage`,
  UI Kit / `render: native`). Pick a project and a fix version to get the score,
  completion, status distribution, the risky issues behind the counters, and
  suggested actions.
- **Release Copilot** — a `rovo:agent` that answers release-health questions in
  Rovo Chat using three tools (`get-release-status`, `list-release-risks`,
  `summarize-release`), with strict tool-usage rules so answers stay grounded.
- **Ship Context tools** — a managed MCP server (`rovo:mcp`) exposing the same
  three actions as MCP tools, so any MCP client can invoke them.
- **GitHub Pull Requests connector** — a `graph:connector` that ingests a
  repository's pull requests into the Teamwork Graph, letting Rovo reason over
  Jira releases and the code behind them together.

## How the score works

`analyseRelease` (in `src/lib/release.js`) runs one JQL search over the fix
version's issues and computes:

- **Risks** — unresolved issues linked by a `Blocks`-type link, issues not
  updated in 7+ days, unestimated issues, high/highest-priority unfinished
  issues, and flagged issues.
- **Score** — 100 minus weighted penalties per risk class, floored by a
  completion factor (`donePercent × 0.85`). Grades: On track ≥ 85,
  Minor concerns ≥ 70, At risk ≥ 50, Off track below that.
- **Suggested actions** — derived from the dominant risk classes so the team
  knows where to start.

## Structure

- `manifest.yml` — modules: global page, Rovo agent, MCP server, three actions,
  Teamwork Graph connector.
- `src/index.js` — resolver (dashboard data) + the three action handlers.
- `src/lib/release.js` — the shared release analysis (JQL, risk finding,
  scoring, summary text). Used by the dashboard and all agent/MCP tools.
- `src/connector.js` — connector `validateConnection` / `onConnectionChange`
  handlers and GitHub → Teamwork Graph object mapping
  (`atlassian:repository`, `atlassian:pull-request`).
- `src/frontend/index.jsx` — the dashboard (UI Kit).

## Development

```bash
forge deploy --non-interactive -e development
forge install --non-interactive --upgrade --site <site> --product jira
```

After changing scopes or egress in `manifest.yml`, redeploy and reinstall
(major version upgrade approval required).
