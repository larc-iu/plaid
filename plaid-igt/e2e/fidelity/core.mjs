// A private plaid-core for the fidelity campaign: its own port, its own
// database, its own media directory, stopped when the run is over.
//
// The dev core on :8085 is shared by every session working this repo, and a
// fidelity run creates and deletes whole projects, so it gets a server nobody
// else is looking at. Everything the core writes is derived from the database
// path (media, the JWT secret, backups), so one temporary directory holds all
// of it.
//
// It runs from SOURCE through the Clojure CLI, not from a built jar, so it is
// always the code in the working tree. Startup takes a while (the namespaces
// compile), which is why `startCore` waits on the login endpoint rather than a
// fixed delay.
//
//   const core = await coreForRun();  // { url, client, stop, dir }
//   ...
//   await core.stop();
//
// PLAID_FIDELITY_CORE_URL (plus PLAID_FIDELITY_TOKEN) points a run at a core
// that is already up instead, which is how to iterate without paying for a
// boot every time: start one with `node e2e/fidelity/core.mjs`, which prints
// both and keeps it running until Ctrl-C.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import PlaidClient from '@larc-iu/plaid-client';

const CORE_DIR = resolve(fileURLToPath(new URL('../../../plaid-core', import.meta.url)));
const ADMIN = { email: 'fidelity@example.com', password: 'fidelity-password' };

const freePort = () =>
  new Promise((ok, fail) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });

const configToml = (port, dir) => `[server]
port = ${port}

[logging]
level = "warn"
library_level = "warn"

[database]
path = "${join(dir, 'plaid.db')}"

[backup]
enabled = false
`;

async function waitForLogin(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`plaid-core exited with code ${child.exitCode} before it was ready`);
    }
    try {
      return await PlaidClient.login(url, ADMIN.email, ADMIN.password);
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`plaid-core was not ready after ${timeoutMs / 1000}s: ${lastError?.message}`);
}

/**
 * Boot a private core and log in as its admin. Resolves to
 * `{url, client, stop, dir}`. `stop` kills the JVM and removes the directory
 * unless `keep` was given.
 */
async function startCore({ timeoutMs = 300_000, keep = false, log = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'plaid-fidelity-'));
  const port = await freePort();
  const configPath = join(dir, 'config.toml');
  await writeFile(configPath, configToml(port, dir));

  const child = spawn(
    'clojure',
    [
      '-J--add-opens=java.base/java.nio=ALL-UNNAMED',
      '-J--enable-native-access=ALL-UNNAMED',
      '-M',
      '-m',
      'plaid.server.main',
      '--config',
      configPath,
    ],
    {
      cwd: CORE_DIR,
      env: {
        ...process.env,
        PLAID_NO_REEXEC: '1',
        PLAID_ADMIN_EMAIL: ADMIN.email,
        PLAID_ADMIN_PASSWORD: ADMIN.password,
      },
      stdio: ['ignore', log ? 'inherit' : 'ignore', log ? 'inherit' : 'pipe'],
    },
  );
  // Keep the last of stderr, so a core that dies during boot says why.
  let stderrTail = '';
  child.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });

  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          r();
        }, 30_000);
        child.once('exit', () => {
          clearTimeout(timer);
          r();
        });
      });
    }
    if (!keep) await rm(dir, { recursive: true, force: true });
  };

  try {
    const client = await waitForLogin(url, child, timeoutMs);
    return { url, client, stop, dir };
  } catch (err) {
    await stop();
    throw new Error(`${err.message}${stderrTail ? `\n${stderrTail}` : ''}`, { cause: err });
  }
}

/**
 * The core a run should use: the one named by PLAID_FIDELITY_CORE_URL and
 * PLAID_FIDELITY_TOKEN when both are set (left running afterwards), otherwise
 * a private one booted for the run.
 */
export async function coreForRun(options = {}) {
  const url = process.env.PLAID_FIDELITY_CORE_URL;
  const token = process.env.PLAID_FIDELITY_TOKEN;
  if (url && token) {
    return { url, client: new PlaidClient(url, token), stop: async () => {}, dir: null };
  }
  return startCore(options);
}

// Run directly: boot one and keep it up, for iterating against.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t0 = Date.now();
  const core = await startCore({ keep: process.argv.includes('--keep') });
  console.log(`plaid-core ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`export PLAID_FIDELITY_CORE_URL=${core.url}`);
  console.log(`export PLAID_FIDELITY_TOKEN=${core.client.token}`);
  console.log(`data: ${core.dir}`);
  const shutdown = async () => {
    await core.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}
