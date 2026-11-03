import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_ROOT = process.env.GRIGDESK_SOURCE_ROOT;

assert.ok(SOURCE_ROOT, 'Задайте GRIGDESK_SOURCE_ROOT для интеграционных тестов');

const require = createRequire(path.join(path.resolve(SOURCE_ROOT), 'server/package.json'));
const Fastify = require('fastify');
const { scanUserPlugins } = await import(pathToFileURL(
  path.join(SOURCE_ROOT, 'server/src/lib/pluginsRegistry.ts'),
).href);
const { default: pluginsModule } = await import(pathToFileURL(
  path.join(SOURCE_ROOT, 'server/src/modules/plugins/index.ts'),
).href);
const PLUGIN_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PAGE = ',forecast:$R[1]={score24h:29,score48h:50}';

/**
 * Загружает копию поставки настоящим runtime, без рабочей папки приложения.
 * Внешняя сеть заменена фикстурой только в тестовом процессе.
 */
async function fixture(t, fetchImpl = async () => new Response(PAGE)) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-codex-reset-test-'));
  const directory = path.join(root, 'codex-reset');

  await mkdir(directory);

  for (const file of ['plugin.json', 'package.json', 'server.js']) {
    await copyFile(path.join(PLUGIN_ROOT, file), path.join(directory, file));
  }

  await cp(path.join(PLUGIN_ROOT, 'src'), path.join(directory, 'src'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', fetchImpl);

  const events = [];
  const app = Fastify({ logger: false });
  const broadcast = (event, data) => events.push({ event, data });
  let prefsData = { plugins: { 'codex-reset': true } };
  const prefs = {
    read: () => prefsData,
    write(patch) {
      prefsData = { ...prefsData, ...patch };
    },
  };

  app.decorateRequest('authKind', 'session');
  app.decorate('sse', { broadcast });
  await app.register(pluginsModule, { config: { userPluginsDir: root }, prefs });
  t.after(() => app.close());

  const toggle = (enabled) => app.inject({
    method: 'POST',
    url: '/api/plugins/codex-reset/toggle',
    payload: { enabled },
  });
  const signals = () => events.filter((entry) => entry.event === 'plugin-event');

  return {
    app,
    root,
    toggle,
    signals,
  };
}

test('API 2 без интерфейса: обнаружение, событие и gate выключенного плагина', async (t) => {
  let calls = 0;
  const host = await fixture(t, async () => {
    calls += 1;

    return new Response(PAGE);
  });
  const manifests = await scanUserPlugins(host.root);
  const manifest = manifests.find((entry) => entry.id === 'codex-reset');

  assert.equal(manifest.api, 2);
  assert.equal(manifest.hasServer, true);
  assert.equal(manifest.web, null);
  assert.equal(manifest.webModule, null);
  assert.equal(manifest.nav, null);
  assert.deepEqual(manifest.placements, [{ slot: 'provider.popover.after-bars', default: true }]);

  const signal = await host.app.inject('/api/ext/codex-reset/signal');

  assert.equal(signal.statusCode, 200);
  assert.equal(signal.json().chance24h, 29);
  assert.equal(calls, 1);
  assert.equal(host.signals().length, 1);
  assert.equal(host.signals()[0].data.pluginId, 'codex-reset');
  assert.equal(host.signals()[0].data.event, 'signal');

  const popup = await host.app.inject('/api/ext/codex-reset/provider-usage?providerId=codex');
  const other = await host.app.inject('/api/ext/codex-reset/provider-usage?providerId=claude');

  assert.equal(popup.statusCode, 200);
  assert.equal(popup.json().resources[1].summary, '29 % / 50 %');
  assert.deepEqual(other.json(), { resources: [] });
  assert.equal(calls, 1);
  assert.equal((await host.toggle(false)).statusCode, 200);
  assert.equal((await host.app.inject('/api/ext/codex-reset/signal')).statusCode, 404);
  assert.equal((await host.toggle(true)).statusCode, 200);
  assert.equal((await host.app.inject('/api/ext/codex-reset/signal')).statusCode, 200);
  assert.equal(calls, 1);
});

test('параллельные читатели получают один сетевой ответ и одно событие', async (t) => {
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  let calls = 0;
  const host = await fixture(t, async () => {
    calls += 1;
    started.resolve();
    await response.promise;

    return new Response(PAGE);
  });

  await host.app.ready();
  await started.promise;

  const reads = Array.from({ length: 3 }, () => host.app.inject('/api/ext/codex-reset/signal'));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.signals().length, 0);
  response.resolve();

  const results = await Promise.all(reads);

  assert.ok(results.every((entry) => entry.statusCode === 200 && entry.json().chance48h === 50));
  assert.equal(calls, 1);
  assert.equal(host.signals().length, 1);
});

test('выключение отменяет фон до публикации, повторное включение восстанавливает загрузку', async (t) => {
  const started = Promise.withResolvers();
  let calls = 0;
  let aborted = false;
  const host = await fixture(t, async (_url, { signal }) => {
    calls += 1;

    if (calls === 1) {
      started.resolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      aborted = signal.aborted;
      signal.throwIfAborted();
    }

    return new Response(PAGE);
  });

  await host.app.ready();
  await started.promise;
  assert.equal((await host.toggle(false)).statusCode, 200);
  assert.equal(aborted, true);
  assert.equal(host.signals().length, 0);
  assert.equal((await host.toggle(true)).statusCode, 200);

  const signal = await host.app.inject('/api/ext/codex-reset/signal');

  assert.equal(signal.json().chance24h, 29);
  assert.equal(calls, 2);
  assert.equal(host.signals().length, 1);
});
