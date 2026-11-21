/**
 * Backend entry point: dashboard resolver + Rovo agent / MCP action handlers.
 */
import Resolver from '@forge/resolver';
import { analyseRelease, listProjects, listVersions, summarizeText } from './lib/release';

const resolver = new Resolver();

// ---------- Dashboard resolver (global page) ----------

resolver.define('getProjects', async () => {
  return listProjects();
});

resolver.define('getVersions', async ({ payload }) => {
  return listVersions(payload.projectKey);
});

resolver.define('getAnalysis', async ({ payload }) => {
  return analyseRelease(payload.projectKey, payload.versionName, true);
});

export const handler = resolver.getDefinitions();

// ---------- Rovo agent / MCP action handlers ----------

/**
 * Action handlers receive { projectKey, versionName } from the action inputs.
 * They run as the app (asApp) since Rovo/tool callers have no user context on
 * the Jira data we aggregate - all data stays inside the installing tenant.
 */
export async function releaseStatus(event) {
  const { projectKey, versionName } = event.inputs || event.payload || event;
  const a = await analyseRelease(projectKey, versionName, false);
  if (a.error) return { error: a.error };
  return {
    score: a.score,
    grade: a.grade,
    donePercent: a.donePercent,
    totalIssues: a.totalIssues,
    byStatus: a.byStatus,
    riskCounts: a.riskCounts,
    released: a.released,
    releaseDate: a.releaseDate,
  };
}

export async function releaseRisks(event) {
  const { projectKey, versionName } = event.inputs || event.payload || event;
  const a = await analyseRelease(projectKey, versionName, false);
  if (a.error) return { error: a.error };
  return { risks: a.risks, total: a.risks.length, actions: a.actions };
}

export async function releaseSummary(event) {
  const { projectKey, versionName } = event.inputs || event.payload || event;
  const a = await analyseRelease(projectKey, versionName, false);
  if (a.error) return { error: a.error };
  return { summary: summarizeText(a) };
}
