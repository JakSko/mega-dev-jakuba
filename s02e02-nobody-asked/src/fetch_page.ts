// fetch_page (spec R6): GET a public web page and return its text. Every host is resolved
// and checked before each request, redirects included, so the tool cannot reach the host
// itself, its private network or a cloud metadata service (SSRF).
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
export type PageResult = { ok: true; url: string; status: number; text: string } | { ok: false; error: string };

const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

function v4Blocked(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind !== 6) return true;
  const x = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapped) return v4Blocked(mapped[1]);
  if (x === '::' || x === '::1') return true;
  if (/^f[cd]/.test(x)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(x)) return true; // fe80::/10 link local
  if (/^ff/.test(x)) return true; // multicast
  if (x.startsWith('64:ff9b:')) return true; // NAT64 can point at private v4
  return false;
}

async function checkUrl(raw: string, lookup: Lookup): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `scheme ${u.protocol} is not allowed`;
  if (u.username || u.password) return 'credentials in the URL are not allowed';
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) return `port ${u.port} is not allowed`;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return 'local host names are not allowed';
  if (isIP(host)) return isBlockedIp(host) ? 'private or local address' : null;
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host);
  } catch {
    return 'host not found';
  }
  if (!addrs.length) return 'host not found';
  if (addrs.some((a) => isBlockedIp(a.address))) return 'host resolves to a private or local address';
  return null;
}

export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  let t = html
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const ent: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  t = t
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, k) => ent[k])
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  t = t.replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return title ? `Title: ${title}\n\n${t}` : t;
}

export async function fetchPage(
  url: string,
  opts: { lookup?: Lookup; fetchImpl?: typeof fetch; maxBytes?: number; timeoutMs?: number; maxRedirects?: number } = {},
): Promise<PageResult> {
  const lookup = opts.lookup ?? defaultLookup;
  const f = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  let current = url;
  try {
    for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
      const bad = await checkUrl(current, lookup);
      if (bad) return { ok: false, error: `refused ${current}: ${bad}` };
      const res = await f(current, { method: 'GET', redirect: 'manual', signal, headers: { 'user-agent': 'mail-reader-agent/1.0', accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location') as string, current).toString();
        continue;
      }
      // Read at most maxBytes, then stop the download.
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (size < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.byteLength;
        }
        await reader.cancel().catch(() => {});
      }
      const buf = new Uint8Array(Math.min(size, maxBytes));
      let off = 0;
      for (const c of chunks) {
        const part = c.subarray(0, Math.min(c.byteLength, buf.byteLength - off));
        buf.set(part, off);
        off += part.byteLength;
        if (off >= buf.byteLength) break;
      }
      const raw = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      const type = res.headers.get('content-type') ?? '';
      const text = /html|xml/i.test(type) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw;
      return { ok: true, url: current, status: res.status, text: size >= maxBytes ? `${text}\n[page cut at ${maxBytes} bytes]` : text };
    }
    return { ok: false, error: 'too many redirects' };
  } catch (e) {
    return { ok: false, error: `could not read the page: ${(e as Error).message}` };
  }
}
