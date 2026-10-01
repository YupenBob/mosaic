import { GITHUB_API, headers } from './github-client.js';
import { getConfig } from './site-config.js';
export async function dispatchWorkflow(c, kind, inputs = {}, config = null) {
  config ||= await getConfig(c);
  const path =
    kind === 'cancel'
      ? `actions/runs/${inputs.runId}/cancel`
      : `actions/workflows/${kind === 'media' ? config.deployment.mediaWorkflow : config.deployment.siteWorkflow}/dispatches`;
  const payload =
    kind === 'cancel'
      ? undefined
      : JSON.stringify({
          ref: config.deployment.branch,
          inputs: {
            timeout_minutes: String(
              Math.min(360, Math.max(10, kind === 'media' ? config.media.timeoutMinutes : config.build.timeoutMinutes)),
            ),
            ...inputs,
          },
        });
  const response = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/${path}`, {
    method: 'POST',
    headers: { ...headers(c), 'Content-Type': 'application/json' },
    body: payload,
  });
  if (!response.ok)
    throw new Error(`GitHub ${kind} dispatch failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  return { method: 'workflow_dispatch', status: response.status };
}
export async function dispatchBuild(c) {
  return dispatchWorkflow(c, 'site');
}
export async function getWorkflowRun(c, id) {
  const response = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/actions/runs/${encodeURIComponent(id)}`, {
    headers: headers(c),
  });
  if (!response.ok) throw new Error(`GitHub run status: ${response.status}`);
  return response.json();
}
/**
 * Assemble the full build detail object (metadata + job step timeline) from a
 * GitHub workflow run. Shared by the latest-run status endpoint and the
 * per-run detail endpoint.
 */
export async function buildRunDetail(c, run) {
  const repo = c.env.GITHUB_REPO;
  const result = {
    id: run.id,
    runNumber: run.run_number,
    status: run.status,
    conclusion: run.conclusion,
    displayTitle: run.display_title,
    headBranch: run.head_branch,
    headSha: run.head_sha?.slice(0, 7),
    headShaFull: run.head_sha || '',
    commitMessage: run.head_commit?.message?.split('\n')[0] || '',
    htmlUrl: run.html_url,
    commitUrl: run.head_sha ? `https://github.com/${repo}/commit/${run.head_sha}` : '',
    repo: `https://github.com/${repo}`,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    event: run.event,
  };

  // Fetch job steps for running or terminal builds (full pipeline timeline)
  if (run.status === 'in_progress' || run.conclusion === 'success' || run.conclusion === 'failure') {
    try {
      const jobsResp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/actions/runs/${run.id}/jobs`, {
        headers: headers(c),
      });
      if (jobsResp.ok) {
        const jobsData = await jobsResp.json();
        const steps = [];
        let jobUrl = '';
        for (const job of jobsData.jobs || []) {
          if (!jobUrl && job.html_url) jobUrl = job.html_url;
          for (const step of job.steps || []) {
            steps.push({
              name: step.name,
              status: step.status,
              conclusion: step.conclusion || '',
              number: step.number,
              startedAt: step.started_at || '',
              completedAt: step.completed_at || '',
            });
          }
        }
        result.steps = steps;
        result.totalSteps = steps.length;
        result.jobUrl = jobUrl;
        const failed = steps.find((s) => s.conclusion === 'failure');
        if (failed) {
          result.failedStep = {
            name: failed.name,
            number: failed.number,
            logUrl: jobUrl ? `${jobUrl}#step:${failed.number}:1` : '',
          };
        }
      }
    } catch {}
  }

  return result;
}

export async function getLatestRun(c) {
  const config = await getConfig(c);
  const resp = await fetch(
    `${GITHUB_API}/repos/${c.env.GITHUB_REPO}/actions/workflows/${config.deployment.siteWorkflow}/runs?per_page=1`,
    {
      headers: headers(c),
    },
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  const run = data.workflow_runs?.[0];
  if (!run) return null;
  return buildRunDetail(c, run);
}

export async function getRunById(c, id) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/actions/runs/${id}`, {
    headers: headers(c),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GitHub getRunById: ${resp.status}`);
  const run = await resp.json();
  return buildRunDetail(c, run);
}

// Cancel the latest running workflow run (requires a token with actions:write).
export async function cancelRun(c) {
  const run = await getLatestRun(c);
  if (!run) return { ok: false, error: 'No build found', status: 404 };
  if (run.status !== 'in_progress' && run.status !== 'queued') {
    return { ok: false, error: 'Build is not running', status: 409 };
  }
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/actions/runs/${run.id}/cancel`, {
    method: 'POST',
    headers: headers(c),
  });
  if (resp.ok || resp.status === 202) return { ok: true, runNumber: run.runNumber };
  if (resp.status === 403) return { ok: false, error: 'Token lacks actions:write permission', status: 403 };
  if (resp.status === 409) return { ok: false, error: 'Build already completed or cancelling', status: 409 };
  return { ok: false, error: `GitHub API ${resp.status}`, status: resp.status };
}

export async function getRunHistory(c) {
  const config = await getConfig(c);
  const resp = await fetch(
    `${GITHUB_API}/repos/${c.env.GITHUB_REPO}/actions/workflows/${config.deployment.siteWorkflow}/runs?per_page=10`,
    {
      headers: headers(c),
    },
  );
  if (!resp.ok) return [];
  const data = await resp.json();
  const repo = c.env.GITHUB_REPO;
  return (data.workflow_runs || []).map((run) => ({
    id: run.id,
    runNumber: run.run_number,
    status: run.status,
    conclusion: run.conclusion,
    displayTitle: run.display_title,
    headBranch: run.head_branch,
    headSha: run.head_sha?.slice(0, 7),
    headShaFull: run.head_sha || '',
    commitMessage: run.head_commit?.message?.split('\n')[0] || '',
    htmlUrl: run.html_url,
    commitUrl: run.head_sha ? `https://github.com/${repo}/commit/${run.head_sha}` : '',
    repo: `https://github.com/${repo}`,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    event: run.event,
  }));
}
