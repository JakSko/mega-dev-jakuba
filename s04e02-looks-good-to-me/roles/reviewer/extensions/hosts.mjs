// Which host each secret may reach, from this role's hosts.json. A secret with no entry reaches no host.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROLE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function mayReach(name, url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') return false;
  try {
    const hosts = JSON.parse(readFileSync(join(ROLE, 'hosts.json'), 'utf8'));
    return Array.isArray(hosts[name]) && hosts[name].includes(u.host);
  } catch {
    return false;
  }
}
