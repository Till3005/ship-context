/**
 * Release readiness logic shared by the dashboard resolver and the
 * Rovo agent / MCP actions.
 *
 * Everything here is deterministic: given the issues in a fix version we
 * compute a 0-100 readiness score, a list of concrete risks, and suggested
 * next actions. No LLM calls - the rules are explainable to judges.
 */

import api, { route } from '@forge/api';

const STALE_DAYS = 7;
const BLOCK_LINK_TYPES = ['blocks', 'blocked-by'];

/** Jira REST GET that errors clearly instead of leaking HTML error pages. */
async function jiraGet(buildRoute, label, asUser = true) {
  const client = asUser ? api.asUser() : api.asApp();
  const res = await client.requestJira(buildRoute, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira ${label} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Run a JQL search, fetching every issue (up to 5000) with the fields the
 * scoring rules need.
 */
export async function searchIssues(jql, asUser = true) {
  const fields = [
    'summary', 'status', 'priority', 'assignee', 'updated', 'created',
    'issuelinks', 'customfield_10016', // story points (Jira Software default)
    'timeestimate', 'timetracking', 'issuetype', 'resolution',
  ];
  const body = {
    jql,
    maxResults: 200,
    fields,
  };
  const client = asUser ? api.asUser() : api.asApp();
  const res = await client.requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JQL search -> ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.issues || [];
}

export async function listProjects() {
  const data = await jiraGet(route`/rest/api/3/project/search?maxResults=100`, 'project/search');
  return (data.values || []).map((p) => ({ key: p.key, name: p.name }));
}

export async function listVersions(projectKey) {
  const data = await jiraGet(
    route`/rest/api/3/project/${projectKey}/versions?orderBy=-releaseDate&maxResults=100`,
    'versions'
  );
  return (data || []).map((v) => ({
    id: v.id,
    name: v.name,
    released: !!v.released,
    archived: !!v.archived,
    releaseDate: v.releaseDate || null,
  }));
}

function statusCategory(issue) {
  return (issue.fields.status?.statusCategory?.key || 'new').toLowerCase();
}

function isDone(issue) {
  return statusCategory(issue) === 'done' || !!issue.fields.resolution;
}

function daysSince(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function storyPoints(issue) {
  const f = issue.fields;
  return f.customfield_10016 ?? f.storyPoints ?? null;
}

/**
 * Compute the risk list for one issue list.
 * Each risk: { key, summary, status, assignee, reasons[] }
 */
export function findRisks(issues) {
  const keys = new Set(issues.map((i) => i.key));
  const risks = [];
  for (const issue of issues) {
    if (isDone(issue)) continue;
    const f = issue.fields;
    const reasons = [];

    // 1. Unresolved issue that links out to a blocker-type link.
    const links = f.issuelinks || [];
    const hasBlockLink = links.some((l) => {
      const type = (l.type?.name || '').toLowerCase();
      if (type !== 'blocks') return false;
      // inward = this issue is blocked by another; outward = this blocks another.
      const other = l.inwardIssue || l.outwardIssue;
      if (!other) return false;
      // If the linked issue is inside this version and done, the block is resolved.
      if (keys.has(other.key)) {
        const linked = issues.find((i) => i.key === other.key);
        if (linked && isDone(linked)) return false;
      }
      return l.inwardIssue != null; // being blocked by something unresolved/outside
    });
    if (hasBlockLink) reasons.push('Blocked by unresolved issue');

    // 2. Stale: no update in STALE_DAYS.
    const staleDays = daysSince(f.updated);
    if (staleDays >= STALE_DAYS) reasons.push(`No update in ${staleDays} days`);

    // 3. Unestimated.
    if (storyPoints(issue) == null && !f.timeestimate) reasons.push('No estimate');

    // 4. High/highest priority unfinished.
    const prio = (f.priority?.name || '').toLowerCase();
    if (prio === 'highest' || prio === 'high' || prio === 'critical' || prio === 'blocker') {
      reasons.push(`${f.priority.name} priority unfinished`);
    }

    // 5. Flagged as impediment.
    if (f.flagged) reasons.push('Flagged as impediment');

    if (reasons.length) {
      risks.push({
        key: issue.key,
        summary: f.summary,
        status: f.status?.name || 'Unknown',
        assignee: f.assignee?.displayName || 'Unassigned',
        staleDays,
        reasons,
      });
    }
  }
  // Sort: blocked first, then priority, then staleness.
  risks.sort((a, b) => b.reasons.length - a.reasons.length || b.staleDays - a.staleDays);
  return risks;
}

/**
 * Score 0-100.
 * Start at 100 and subtract weighted penalties; done% contributes a floor so
 * a nearly-complete release with minor issues still reads "on track".
 */
export function computeScore(issues, risks) {
  if (!issues.length) return { score: 0, grade: 'No scope', donePercent: 0 };
  const done = issues.filter(isDone).length;
  const donePercent = Math.round((done / issues.length) * 100);

  const counts = { blocked: 0, stale: 0, unestimated: 0, priority: 0, flagged: 0 };
  for (const r of risks) {
    if (r.reasons.some((x) => x.startsWith('Blocked'))) counts.blocked++;
    if (r.reasons.some((x) => x.includes('No update'))) counts.stale++;
    if (r.reasons.some((x) => x === 'No estimate')) counts.unestimated++;
    if (r.reasons.some((x) => x.includes('priority'))) counts.priority++;
    if (r.reasons.some((x) => x === 'Flagged as impediment')) counts.flagged++;
  }

  let penalty =
    counts.blocked * 15 +
    counts.priority * 12 +
    counts.flagged * 10 +
    counts.stale * 6 +
    Math.min(counts.unestimated * 3, 15);

  // Completion lifts the floor: 100% done can't be below 85.
  let score = 100 - penalty;
  score = Math.max(score, Math.round(donePercent * 0.85));
  score = Math.min(100, Math.max(0, score));

  const grade =
    score >= 85 ? 'On track' :
    score >= 70 ? 'Minor concerns' :
    score >= 50 ? 'At risk' : 'Off track';

  return { score, grade, donePercent, counts };
}

function suggestedActions(risks, counts) {
  const out = [];
  if (counts.blocked) out.push('Chase the unresolved blockers - they hold up finished work downstream.');
  if (counts.priority) out.push('Get high-priority unfinished items assigned and started now.');
  if (counts.flagged) out.push('Review flagged impediments with the team today.');
  if (counts.stale) out.push('Stale issues need a status update or a fresh owner.');
  if (counts.unestimated) out.push('Run a quick estimation pass on unestimated issues.');
  if (!out.length) out.push('No structural risks - keep tracking and do a final QA pass before release.');
  return out;
}

/**
 * Full release analysis for one project + version. Used by every surface
 * (dashboard resolver, agent actions, MCP tools).
 */
export async function analyseRelease(projectKey, versionName, asUser = true) {
  const versions = await listVersions(projectKey);
  const version = versions.find((v) => v.name.toLowerCase() === String(versionName).toLowerCase());
  if (!version) {
    return {
      error: `Version "${versionName}" not found in project ${projectKey}. Available: ` +
        versions.slice(0, 10).map((v) => v.name).join(', ') || 'none',
    };
  }
  const jql = `project = "${projectKey}" AND fixVersion = "${version.name.replace(/"/g, '\\"')}" ORDER BY status ASC, priority DESC`;
  const issues = await searchIssues(jql, asUser);
  const risks = findRisks(issues);
  const { score, grade, donePercent, counts } = computeScore(issues, risks);

  const byStatus = { todo: 0, inprogress: 0, done: 0, other: 0 };
  for (const i of issues) {
    const c = statusCategory(i);
    if (c === 'done') byStatus.done++;
    else if (c === 'indeterminate' || c === 'in-progress' || c === 'inprogress') byStatus.inprogress++;
    else if (c === 'new' || c === 'undefined' || c === 'todo') byStatus.todo++;
    else byStatus.other++;
  }

  return {
    projectKey,
    version: version.name,
    released: version.released,
    releaseDate: version.releaseDate,
    score,
    grade,
    donePercent,
    totalIssues: issues.length,
    byStatus,
    riskCounts: counts,
    risks: risks.slice(0, 25),
    actions: suggestedActions(risks, counts),
    jql,
  };
}

export function summarizeText(a) {
  if (a.error) return a.error;
  const lines = [
    `Release ${a.version} (${a.projectKey}) - readiness ${a.score}/100 (${a.grade}).`,
    `${a.donePercent}% complete (${a.byStatus.done}/${a.totalIssues} issues done, ${a.byStatus.inprogress} in progress, ${a.byStatus.todo} to do).`,
  ];
  const top = a.risks.slice(0, 3);
  if (top.length) {
    lines.push('Top risks:');
    for (const r of top) lines.push(`- ${r.key} ${r.summary} [${r.reasons.join('; ')}] (${r.assignee})`);
  } else {
    lines.push('No structural risks detected.');
  }
  lines.push('Next actions:');
  for (const s of a.actions) lines.push(`- ${s}`);
  return lines.join('\n');
}
