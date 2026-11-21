// Teamwork Graph connector: ingests pull requests from a GitHub repository
// into Atlassian's Teamwork Graph so they surface in Rovo Search and Rovo Chat
// alongside the Jira issues this app analyses.
//
// Atlassian calls the two exported handlers directly with the request object:
// configuration values arrive on `request.configProperties` (not nested under
// an event payload).

import api from '@forge/api';
import { kvs } from '@forge/kvs';
import { graph } from '@forge/teamwork-graph';

const GITHUB_API = 'https://api.github.com';
const MAX_PRS = 50;

// Headers for every GitHub REST call. A token is optional (public repos).
const githubHeaders = (token) => ({
  Accept: 'application/vnd.github+json',
  'User-Agent': 'ship-context-forge-app',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

// validateConnection — Atlassian invokes this when an admin submits the
// connection form, and periodically afterwards as a health check. Keep it
// read-only and cheap: a single repository metadata call.
export const validateConnection = async (request) => {
  const { repoOwner, repoName, token } = request.configProperties || {};
  if (!repoOwner || !repoName) {
    return { success: false, message: 'Repository owner and name are required.' };
  }

  const response = await api.fetch(
    `${GITHUB_API}/repos/${repoOwner}/${repoName}`,
    { method: 'GET', headers: githubHeaders(token) },
  );

  if (response.ok) return { success: true };
  if (response.status === 401) {
    return { success: false, message: 'The GitHub token is invalid or expired.' };
  }
  if (response.status === 404) {
    return { success: false, message: `Repository ${repoOwner}/${repoName} was not found.` };
  }
  return { success: false, message: `GitHub returned HTTP ${response.status}.` };
};

// onConnectionChange — runs when the admin creates, updates or deletes the
// connection. On CREATED/UPDATED we persist the config and re-ingest; on
// DELETED we only clean local state (Atlassian removes graph data itself).
export const onConnectionChange = async (request) => {
  const { action, connectionId, configProperties } = request;
  const config = configProperties || {};

  if (action === 'DELETED') {
    await kvs.delete(`conn:${connectionId}`);
    console.log(`[connector] Connection deleted: ${connectionId}`);
    return { success: true };
  }

  await kvs.set(`conn:${connectionId}`, {
    repoOwner: config.repoOwner,
    repoName: config.repoName,
  });

  const objects = await buildObjects(config);
  console.log(`[connector] Ingesting ${objects.length} objects for ${connectionId}`);

  // setObjects accepts at most 100 objects per call.
  for (let i = 0; i < objects.length; i += 100) {
    const batch = objects.slice(i, i + 100);
    const result = await graph.setObjects({ connectionId, objects: batch });
    const rejected = result.results?.rejected ?? [];
    if (!result.success || rejected.length > 0) {
      console.error('[connector] setObjects partial failure', {
        accepted: result.results?.accepted?.length ?? 0,
        rejected,
        error: result.error,
      });
    }
  }
  return { success: true };
};

// Fetches the repository plus its most recently updated pull requests and
// maps both to Teamwork Graph objects.
const buildObjects = async (config) => {
  const { repoOwner, repoName, token } = config;
  const headers = githubHeaders(token);
  const repoId = `gh:${repoOwner}/${repoName}`;
  const everyone = [{ accessControls: [{ principals: [{ type: 'EVERYONE' }] }] }];

  const repoResponse = await api.fetch(`${GITHUB_API}/repos/${repoOwner}/${repoName}`, {
    method: 'GET',
    headers,
  });
  if (!repoResponse.ok) {
    throw new Error(`GitHub repository fetch failed: HTTP ${repoResponse.status}`);
  }
  const repo = await repoResponse.json();

  const repoObject = {
    schemaVersion: '1.0',
    id: repoId,
    updateSequenceNumber: 1,
    displayName: repo.full_name,
    description: repo.description || undefined,
    url: repo.html_url,
    createdAt: repo.created_at,
    lastUpdatedAt: repo.updated_at,
    permissions: everyone,
    'atlassian:repository': {
      name: repo.full_name,
      avatar: repo.owner?.avatar_url,
      avatarDescription: `Avatar of ${repoOwner}`,
    },
  };

  const prResponse = await api.fetch(
    `${GITHUB_API}/repos/${repoOwner}/${repoName}/pulls?state=all&per_page=${MAX_PRS}&sort=updated&direction=desc`,
    { method: 'GET', headers },
  );
  if (!prResponse.ok) {
    throw new Error(`GitHub pulls fetch failed: HTTP ${prResponse.status}`);
  }
  const pulls = await prResponse.json();

  const prObjects = pulls.map((pr) => ({
    schemaVersion: '1.0',
    id: `${repoId}#${pr.number}`,
    updateSequenceNumber: 1,
    displayName: `#${pr.number} ${pr.title}`,
    url: pr.html_url,
    createdAt: pr.created_at,
    lastUpdatedAt: pr.updated_at,
    containerKey: { type: 'atlassian:repository', value: { id: repoId } },
    permissions: everyone,
    'atlassian:pull-request': {
      displayId: `#${pr.number}`,
      title: pr.title,
      status: prStatus(pr),
      author: pr.user ? { externalId: pr.user.login, name: pr.user.login } : undefined,
      sourceBranch: pr.head?.ref || '',
      destinationBranch: pr.base?.ref || '',
      reviewers: [],
      commentCount: pr.comments,
    },
  }));

  return [repoObject, ...prObjects];
};

const prStatus = (pr) => {
  if (pr.merged_at || pr.state === 'closed' && pr.merged_at) return 'merged';
  if (pr.state === 'open') return pr.draft ? 'draft' : 'open';
  return 'declined';
};
