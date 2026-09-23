/* ============================================================
   lib/gh.mjs — the GitHub Contents API plumbing shared by the
   functions that read and write cloud copies.

   Repo coordinates come from env (REPO_OWNER / REPO_NAME /
   REPO_BRANCH / REPO_FILE) with the same defaults sync.mjs has
   always used, so a deployment needs no new variables. The token
   never reaches the browser: every call here happens server-side.
   ============================================================ */

const GH_API = 'https://api.github.com';

/** Call the GitHub API with the deployment's token. */
export async function ghFetch(path, opts = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN env var not set on the function');
  const url = path.startsWith('http') ? path : `${GH_API}${path}`;
  return fetch(url, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cents-app',
      ...(opts.headers || {}),
    },
  });
}

/** Repo coordinates for this deployment. */
export function ghConfig() {
  return {
    owner: process.env.REPO_OWNER,
    repo: process.env.REPO_NAME,
    branch: process.env.REPO_BRANCH || 'main',
    file: (process.env.REPO_FILE || 'data.json').replace(/^\/+/, ''),
  };
}

/** Contents API path for one file, with the branch pinned. */
export function contentsPath({ owner, repo, file, branch }) {
  return `/repos/${owner}/${repo}/contents/${encodeURIComponent(file)}?ref=${encodeURIComponent(branch)}`;
}

export function decodeBase64(b64) {
  return Buffer.from(b64, 'base64').toString('utf8');
}

export function encodeBase64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}
