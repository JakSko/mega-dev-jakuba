// Starts the reviewer once: Pi in print mode with the two tools of extensions/review.mjs and no others.
// MODEL is a plain model id.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const model = process.env.MODEL;
if (model && !/^[\w./:@-]+$/.test(model)) {
  console.error('MODEL may hold letters, digits and . / : @ - _ only.');
  process.exit(1);
}
const args = [
  '-p', '--no-session', '--no-builtin-tools', '--no-extensions', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-mcp',
  '-e', 'extensions/review.mjs',
  '--system-prompt', 'ROLE.md',
  ...(model ? ['--model', model] : []),
  'Start.',
];
// On Windows `pi` is a .cmd launcher, which needs a shell; no argument holds a space.
const win = process.platform === 'win32';
const child = spawn(win ? 'pi.cmd' : 'pi', args, { cwd: dirname(fileURLToPath(import.meta.url)), stdio: ['ignore', 'inherit', 'inherit'], shell: win });
child.on('close', (code) => process.exit(code ?? 1));
