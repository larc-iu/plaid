// The real IGT assistant service (plaid-agent), started for one spec against a
// scripted model that answers every completion with "OK.". Approving a plan
// never reaches the model: the service checks the plan, applies it as the
// user and settles the record, which is what a spec wants to see done for
// real. The model is only there for the startup ping.
//
// Needs the plaid-agent Python env: PLAID_AGENT_PYTHON, else the env's python
// under the usual mamba roots (the lookup bb uses). `agentUnavailable()` says
// why it cannot run, for a skip. The service is pointed at PLAID_CORE_URL
// (default :8085), the variable fixtureProject.js reads, so a run against a
// private core has to set it.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE_URL = process.env.PLAID_CORE_URL || 'http://localhost:8085';
const PYTHONPATH = [
  path.join(REPO, 'plaid-agent', 'src'),
  path.join(REPO, 'plaid-client-py', 'src'),
].join(path.delimiter);

const agentPython = () =>
  process.env.PLAID_AGENT_PYTHON ||
  ['.miniforge3', 'miniforge3', '.mambaforge', 'mambaforge', 'micromamba', 'miniconda3']
    .map((root) => path.join(os.homedir(), root, 'envs', 'plaid-agent', 'bin', 'python'))
    .find((p) => fs.existsSync(p));

// Null when the service can be started here, else the reason it cannot.
export function agentUnavailable() {
  const python = agentPython();
  if (!python) return 'no plaid-agent Python env (set PLAID_AGENT_PYTHON)';
  const probe = spawnSync(python, ['-c', 'import plaid_agent.igt.service, litellm'], {
    env: { ...process.env, PYTHONPATH },
    encoding: 'utf8',
  });
  if (probe.status !== 0)
    return `plaid-agent does not import: ${probe.stderr.trim().split('\n').pop()}`;
  return null;
}

// An OpenAI-compatible endpoint that answers "OK." to anything, streamed or not.
function startFakeModel() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        /* answered the same */
      }
      const base = {
        id: 'chatcmpl-e2e',
        created: Math.floor(Date.now() / 1000),
        model: 'e2e-fake',
      };
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta, finish = null) =>
          res.write(
            `data: ${JSON.stringify({
              ...base,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`,
          );
        chunk({ role: 'assistant', content: 'OK.' });
        chunk({}, 'stop');
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'OK.' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })),
  );
}

// Starts the service on one project under `serviceId`, with the token given
// (the service reads it from a `.token` in its working directory). Returns
// `stop()`, which ends the process and the model, and `log()`, the service's
// output so far, for a failure message.
export async function startIgtAssistant({ token, projectId, serviceId }) {
  const { server, port } = await startFakeModel();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaid-e2e-agent-'));
  fs.writeFileSync(path.join(dir, '.token'), token);
  let output = '';
  const child = spawn(
    agentPython(),
    [
      '-m',
      'plaid_agent.igt.service',
      projectId,
      '--url',
      CORE_URL,
      '--model',
      'openai/e2e-fake',
      '--api-base',
      `http://127.0.0.1:${port}/v1`,
      '--api-key',
      'e2e',
      '--service-id',
      serviceId,
    ],
    { cwd: dir, env: { ...process.env, PYTHONPATH }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return {
    log: () => output,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        await exited;
        clearTimeout(timer);
      }
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
