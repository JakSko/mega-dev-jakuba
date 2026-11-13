// Example API for the runner's tests and rehearsals: a small Cloudflare Worker that serves
// incidents read from an upstream feed. Written for this folder; the runner changes this code.

const reply = (body, status = 200) => Response.json(body, { status });

// One read of the upstream feed. FEED_URL is a Worker secret, never a [vars] entry.
async function readFeed(env) {
  if (!env.FEED_URL) throw new Error('FEED_URL is not set');
  const upstream = await fetch(env.FEED_URL);
  if (!upstream.ok) throw new Error(`feed answered ${upstream.status}`);
  const data = await upstream.json();
  if (!Array.isArray(data.incidents)) throw new Error('feed answer has no incidents array');
  return data.incidents;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/incidents') {
      try {
        return reply({ incidents: await readFeed(env) });
      } catch (err) {
        // Every answer is JSON. The cause goes to the log, never to the caller.
        console.error(`incidents: ${err.message}`);
        return reply({ error: 'feed unavailable' }, 502);
      }
    }
    return reply({ error: 'not found' }, 404);
  },
};
