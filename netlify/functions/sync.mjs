/* ============================================================
   Netlify Function v2 — GitHub sync proxy for cents.

   Reads/writes a single JSON file in a configured GitHub repo via
   the Contents API, gated by an admin password sent via the
   X-Cents-Password header. The PAT itself lives only in this
   function's environment, never in the client bundle.

   Required env vars:
     GITHUB_TOKEN    fine-grained PAT, repo contents: read+write
     REPO_OWNER      e.g. "yourname"
     REPO_NAME       e.g. "cents-data"
     REPO_BRANCH     default "main"
     REPO_FILE       default "data.json"
     APP_PASSWORD    any string the client sends in X-Cents-Password
   ============================================================ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Cents-Password',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const ok = (body, status = 200) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', ...CORS } },
);
const err = (msg, status = 400) => ok({ error: msg, code: status }, status);

const GH_API = 'https://api.github.com';

async function ghFetch(path, opts = {}) {
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

function cfg() {
  return {
    owner:  process.env.REPO_OWNER,
    repo:   process.env.REPO_NAME,
    branch: process.env.REPO_BRANCH || 'main',
    file:   (process.env.REPO_FILE || 'data.json').replace(/^\/+/, ''),
  };
}

function authenticate(request) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return { ok: false, msg: 'APP_PASSWORD env var not set on the function' };
  const got = request.headers.get('x-cents-password') || '';
  if (got !== expected) return { ok: false, msg: 'Bad app password' };
  return { ok: true };
}

function decodeBase64(b64) {
  return Buffer.from(b64, 'base64').toString('utf8');
}
function encodeBase64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

export default async (request, _context) => {
  if (request.method === 'OPTIONS') return ok({}, 200);

  const auth = authenticate(request);
  if (!auth.ok) return err(auth.msg, 401);

  const { owner, repo, branch, file } = cfg();
  if (!owner || !repo) return err('REPO_OWNER / REPO_NAME env vars not set on the function', 500);

  try {
    // ---------- READ ----------
    if (request.method === 'GET') {
      const r = await ghFetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(file)}?ref=${encodeURIComponent(branch)}`);
      if (r.status === 404) return ok({ content: null, sha: null, branch });
      if (!r.ok) {
        const text = await r.text();
        return err(`GitHub read failed: ${r.status} ${text.slice(0, 240)}`, r.status);
      }
      const j = await r.json();
      const text = decodeBase64(j.content || '');
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      return ok({
        content: parsed,
        sha: j.sha,
        branch,
        size: j.size,
        lastModifiedAt: j.updated_at || j.commit?.author?.date || null,
        commitSha: j.commit?.sha || null,
        path: j.path || file,
      });
    }

    // ---------- WRITE ----------
    if (request.method === 'PUT') {
      const rawBody = await request.text();
      let body;
      try { body = JSON.parse(rawBody || '{}'); }
      catch { return err('Body is not valid JSON', 400); }

      const incoming = body.content;
      if (!incoming || !Array.isArray(incoming.entries)) {
        return err('Body.content must be an object with an entries[] array', 400);
      }

      const sha    = body.sha || null;
      const msg    = typeof body.message === 'string' && body.message.trim()
                       ? body.message.trim().slice(0, 200)
                       : 'cents: update expenses';
      const branchParam = body.branch || branch;
      const encoded = encodeBase64(JSON.stringify(incoming, null, 2));

      const putBody = { message: msg, content: encoded, branch: branchParam };
      if (sha) putBody.sha = sha;

      const r = await ghFetch(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(file)}`,
        { method: 'PUT', body: JSON.stringify(putBody) }
      );

      if (r.status === 409 || r.status === 422) {
        return ok({ conflict: true, status: r.status }, 200);
      }
      if (!r.ok) {
        const text = await r.text();
        return err(`GitHub write failed: ${r.status} ${text.slice(0, 240)}`, r.status);
      }

      const j = await r.json();
      return ok({
        sha: j.content?.sha || null,
        commit: j.commit?.sha || null,
        branch: branchParam,
        lastModifiedAt: j.commit?.author?.date || j.content?.updated_at || null,
      });
    }

    return err('Method not allowed', 405);
  } catch (e) {
    return err(e?.message || 'Internal error', 500);
  }
};
