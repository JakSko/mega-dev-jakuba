// TEST ONLY. The gate with a fake model server in the same container.
// This file never goes into the production volume: gate.mjs alone has no setting that changes the upstream.
import { createServer } from 'node:http';
import { createGate, configFromEnv } from './gate.mjs';

const KEY = process.env.OPENAI_API_KEY ?? '';
const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok from the fake model', annotations: [] }] };
const response = { id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-6.2-sol', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
const events = [
  { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
  { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'msg_1', part: { type: 'output_text', text: '', annotations: [] } },
  { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: 'ok from the fake model' },
  { type: 'response.output_item.done', output_index: 0, item },
  { type: 'response.completed', response },
];

// With FAKE_TOOL_CALL=1 the first turn asks for one bash call, so the client sends the call and its result back.
const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: JSON.stringify({ command: 'echo course-box-$((6*7))', timeout: null }), status: 'completed' };
const toolEvents = [
  events[0],
  { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } },
  { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: call.arguments },
  { type: 'response.output_item.done', output_index: 0, item: call },
  { type: 'response.completed', response: { ...response, output: [call] } },
];

createServer((req, res) => {
  let sent = '';
  req.on('data', (d) => (sent += d));
  req.on('end', () => {
    const wantsTool = process.env.FAKE_TOOL_CALL === '1' && !sent.includes('"function_call_output"');
    const reply = wantsTool ? toolEvents : events;
    // Says only whether the key matched, never the key.
    console.log(JSON.stringify({ fake: true, realKeyArrived: KEY !== '' && req.headers.authorization === `Bearer ${KEY}` }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(reply.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join(''));
  });
}).listen(9999, '127.0.0.1');

const gate = createGate({ ...configFromEnv(process.env), upstream: new URL('http://127.0.0.1:9999') });
gate.model.listen(8081, '0.0.0.0');
gate.proxy.listen(8080, '0.0.0.0');
console.log(JSON.stringify({ event: 'start', test: true }));
