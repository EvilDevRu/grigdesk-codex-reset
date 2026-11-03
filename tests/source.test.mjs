import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSource, HOMEPAGE, MAX_BYTES, parsePage, TTL_MS } from '../src/source.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const RESET_AT = '2026-10-28T06:29:38.000Z';

/**
 * Строит короткий пример обоих форматов сериализатора вместо копии чужой страницы.
 * Вложенные оценки отличаются от итоговых, чтобы проверить выбор нужного уровня.
 */
function page({ assignment = true, url = 'https://x.com/example/status/1', date = RESET_AT } = {}) {
  const record = {
    id: 'reset:1',
    dateTime: date,
    title: 'Reset {done}, "ok"',
    type: 'forced-reset',
    scope: 'Shared/global',
    sourceLabel: 'X',
    sourceUrl: url,
  };
  const fields = Object.entries(record).map(([key, value]) => `${key}:${JSON.stringify(value)}`).join(',');

  return `<script>({history:[{${fields}}],forecast:${assignment ? '$R[248]=' : ''}{`
    + 'breakdown:{score24h:99,score48h:100},reason:"a } , b",score24h:29,score48h:50}})</script>';
}

test('старый и текущий сериализаторы: итоговые оценки и строки со скобками', () => {
  for (const assignment of [false, true]) {
    const result = parsePage(page({ assignment }), NOW);

    assert.equal(result.lastReset.at, RESET_AT);
    assert.equal(result.lastReset.title, 'Reset {done}, "ok"');
    assert.equal(result.chance24h, 29);
    assert.equal(result.chance48h, 50);
  }
});

test('будущие сбросы и опасные ссылки не становятся подтверждением', () => {
  assert.equal(parsePage(page({ date: '2026-11-05T12:00:00Z' }), NOW).lastReset, null);

  for (const url of ['javascript:alert(1)', 'https://x.com.evil.test/a', 'http://x.com/a',
    'https://u:p@x.com/a', 'https://x.com:444/a']) {
    assert.equal(parsePage(page({ url }), NOW).lastReset.sourceUrl, null);
  }
});

test('выбирается последний состоявшийся сброс, числа вне диапазона отвергаются', () => {
  const html = page({ date: '2026-10-27T00:00:00Z' }) + page();

  assert.equal(parsePage(html, NOW).lastReset.at, RESET_AT);
  assert.equal(parsePage(',forecast:{score24h:101,score48h:-1}', NOW).chance24h, null);
  assert.equal(parsePage(',forecast:{score24h:101,score48h:-1}', NOW).chance48h, null);
  assert.equal(parsePage(',forecast:{score24h:0,score48h:100}', NOW).chance24h, 0);
  assert.equal(parsePage(',forecast:{nested:{score24h:99}}', NOW).chance24h, null);
  assert.equal(parsePage(',forecast:{score24h:42', NOW).chance24h, null);
});

test('произвольный скрипт сайта не исполняется', () => {
  const html = '<script>globalThis.__codexResetExecution = true;</script>' + page();

  assert.equal(parsePage(html, NOW).chance48h, 50);
  assert.equal(globalThis.__codexResetExecution, undefined);
});

test('один запрос на несколько читателей, часовой кэш и фиксированный адрес', async () => {
  let at = NOW;
  let calls = 0;
  const source = createSource({ now: () => at, fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(url, HOMEPAGE);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, undefined);

    return new Response(page());
  } });

  const results = await Promise.all([source.read(), source.read(), source.read()]);

  assert.equal(calls, 1);
  assert.ok(results.every((entry) => entry.chance24h === 29 && !entry.stale));
  await source.read();
  assert.equal(calls, 1);
  at += TTL_MS;
  await source.read();
  assert.equal(calls, 2);
  await source.stop();
});

test('ошибка сохраняет данные с пометкой stale и ограничивает повторы', async () => {
  let at = NOW;
  let calls = 0;
  const source = createSource({ now: () => at, fetchImpl: async () => {
    calls += 1;

    return new Response(calls === 1 ? page() : 'unavailable', { status: calls === 1 ? 200 : 503 });
  } });

  await source.read();
  at += TTL_MS;

  const failed = await source.read();

  assert.equal(failed.error, 'http_error');
  assert.equal(failed.stale, true);
  assert.equal(failed.lastReset.at, RESET_AT);
  await source.read();
  assert.equal(calls, 2);
  at += TTL_MS / 10;
  await source.read();
  assert.equal(calls, 3);
  await source.stop();
});

test('смена вёрстки не подменяет успешные данные пустым ответом', async () => {
  let at = NOW;
  let calls = 0;
  const source = createSource({ now: () => at, fetchImpl: async () => {
    calls += 1;

    return new Response(calls === 1 ? page() : '<html>new layout</html>');
  } });

  const first = await source.read();

  at += TTL_MS;

  const failed = await source.read();

  assert.equal(failed.error, 'invalid_page');
  assert.equal(failed.fetchedAt, first.fetchedAt);
  assert.equal(failed.chance24h, 29);
  await source.stop();
});

test('размер ограничен по заголовку и по потоку без Content-Length', async () => {
  for (const header of [false, true]) {
    const source = createSource({ now: () => NOW, fetchImpl: async () => new Response(
      'x'.repeat(MAX_BYTES + 1),
      { headers: header ? { 'content-length': String(MAX_BYTES + 1) } : {} },
    ) });

    assert.equal((await source.read()).error, 'response_too_large');
    await source.stop();
  }
});

test('выключение прерывает запрос; быстрое включение не принимает старый ответ', async () => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const source = createSource({ now: () => NOW, fetchImpl: async (_url, { signal }) => {
    calls += 1;

    if (calls > 1) {
      return new Response(page());
    }

    started();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));

    return new Response(page({ date: '2026-10-29T00:00:00Z' }));
  } });

  const reading = source.read();

  await ready;

  const stopping = source.stop();

  source.resume();
  await stopping;
  await reading;
  assert.equal(source.peek().lastReset, null);
  assert.equal(source.peek().error, null);
  assert.equal((await source.read()).lastReset.at, RESET_AT);
  await source.stop();
  await source.read();
  assert.equal(calls, 2);
});

test('таймаут действует во время получения ответа', async () => {
  const source = createSource({
    now: () => NOW,
    timeoutMs: 20,
    fetchImpl: async (_url, { signal }) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      signal.throwIfAborted();
    },
  });
  const keeper = setTimeout(() => {}, 1000);

  try {
    assert.equal((await source.read()).error, 'timeout');
  } finally {
    clearTimeout(keeper);
    await source.stop();
  }
});
