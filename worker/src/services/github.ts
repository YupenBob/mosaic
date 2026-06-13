/**
 * GitHub API helpers.
 * Used to trigger builds and query workflow status.
 */

import type { Env, BuildStatus, BuildHistoryItem } from '../types';

const GITHUB_API = 'https://api.github.com';

function authHeaders(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mosaic-api/0.8',
  };
}

/**
 * Trigger a GitHub Actions workflow via repository_dispatch.
 */
export async function triggerBuild(env: Env): Promise<{ ok: boolean; error?: string }> {
  const url = `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({
      event_type: 'publish',
      client_payload: {
        timestamp: new Date().toISOString(),
        source: 'cloud-admin',
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    return { ok: false, error: `GitHub API error ${resp.status}: ${body}` };
  }

  return { ok: true };
}

/**
 * Get the latest workflow run status.
 */
export async function getLatestBuildStatus(env: Env): Promise<BuildStatus | null> {
  const url = `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs`
    + `?workflow_id=build.yml&per_page=1`;

  const resp = await fetch(url, { headers: authHeaders(env) });

  if (!resp.ok) return null;

  const data = (await resp.json()) as {
    workflow_runs: Array<{
      id: number;
      status: string;
      conclusion: string | null;
      created_at: string;
      updated_at: string;
      html_url: string;
    }>;
  };

  if (!data.workflow_runs || data.workflow_runs.length === 0) return null;

  const run = data.workflow_runs[0];
  return {
    id: String(run.id),
    status: run.status as BuildStatus['status'],
    conclusion: run.conclusion as BuildStatus['conclusion'],
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    htmlUrl: run.html_url,
  };
}

/**
 * Get build history (last 20 runs).
 */
export async function getBuildHistory(env: Env): Promise<BuildHistoryItem[]> {
  const url = `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs`
    + `?workflow_id=build.yml&per_page=20`;

  const resp = await fetch(url, { headers: authHeaders(env) });

  if (!resp.ok) return [];

  const data = (await resp.json()) as {
    workflow_runs: Array<{
      id: number;
      run_number: number;
      status: string;
      conclusion: string | null;
      created_at: string;
    }>;
  };

  return (data.workflow_runs || []).map((run) => ({
    id: String(run.id),
    runNumber: run.run_number,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.created_at,
  }));
}

/**
 * Get git status (branch + changed files) — read-only.
 */
export async function getGitStatus(env: Env): Promise<{ branch: string; files: string[] }> {
  const branchUrl = `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const branchResp = await fetch(branchUrl, { headers: authHeaders(env) });
  const repoData = (await branchResp.json()) as { default_branch: string };

  return {
    branch: repoData.default_branch || 'main',
    files: [], // Read-only via API — file list not available without commit comparison
  };
}
