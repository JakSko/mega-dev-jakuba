// Deploys the working copy with the repo's own pinned wrangler and says which version is active.
import { spawnSync } from 'node:child_process';

export function makeWranglerDeployer({ work, token, accountId, scriptName, out, log }) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, CI: '1' };

  async function activeVersion() {
    // Cloudflare's deployments API: the newest deployment names the version that serves traffic.
    const r = await out(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/deployments`,
      { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const dep = r.json().result?.deployments?.[0];
    return dep?.versions?.[0]?.version_id ?? null;
  }

  return {
    async deploy() {
      const r = spawnSync('npx', ['wrangler', 'deploy', '--env', 'production'], { cwd: work, env, encoding: 'utf8', timeout: 240000, shell: process.platform === 'win32' });
      const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      const versionId = /Current Version ID:\s*([0-9a-f-]{36})/i.exec(text)?.[1] ?? null;
      const url = /https:\/\/[^\s]+\.workers\.dev/.exec(text)?.[0] ?? null;
      log('wrangler', { code: r.status, versionId, url, tail: text.slice(-500) });
      if (r.status !== 0 || !versionId) return { ok: false, versionId, url, note: 'wrangler deploy failed' };
      let active = null;
      try { active = await activeVersion(); } catch (err) { log('deployments-api', { err: err.message }); }
      // If the API answers, it must name our version. If it does not answer, the live checks decide.
      if (active && active !== versionId) return { ok: false, versionId, url, note: `active version is ${active}` };
      return { ok: true, versionId, url, note: active ? 'active version confirmed' : 'deployments API gave no answer' };
    },
  };
}
