// Makes a Standard Webhooks request (docs/course-api.md) signed with a TEST key, for local runs.
// Never used with the course's ping key.
import { createHmac, randomBytes } from 'node:crypto';

export const newTestKey = () => `whsec_${randomBytes(32).toString('base64')}`;

export function signedHeaders(key, body, { id = `msg_${randomBytes(6).toString('hex')}`, ts = Math.floor(Date.now() / 1000) } = {}) {
  const sig = createHmac('sha256', Buffer.from(key.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
  return {
    'content-type': 'application/json',
    'user-agent': 'mega-course-pings/1 (+local test)',
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    'webhook-signature': `v1,${sig}`,
  };
}
