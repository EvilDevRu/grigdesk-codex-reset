import assert from 'node:assert/strict';
import test from 'node:test';

import { providerResources } from '../src/providerResources.js';

const signal = {
  stale: false,
  lastReset: { at: '2026-10-28T06:29:38.000Z' },
  fetchedAt: '2026-11-04T01:00:00.000Z',
  chance24h: 0,
  chance48h: 50,
};
const NOW = Date.parse('2026-11-04T01:00:00.000Z');

test('ресурсы popup показывают давность сброса, нулевую оценку и атрибуцию', () => {
  const resources = providerResources(signal, NOW);

  assert.equal(resources[0].summary, '6 дней назад');
  assert.equal(resources[0].translations.en.summary, '6 days ago');
  assert.equal(resources[0].controls[0].href, 'https://codexreset.org/');
  assert.equal(resources[1].summary, '0 % / 50 %');
  assert.match(resources[1].note, /не гарантия/);
  assert.match(resources[1].translations.en.note, /not a guaranteed reset/);
});

test('давность сброса: минуты, часы и дни с правильными окончаниями RU/EN', () => {
  const cases = [
    [0, 'только что', 'just now'],
    [59_999, 'только что', 'just now'],
    [60_000, '1 минуту назад', '1 minute ago'],
    [2 * 60_000, '2 минуты назад', '2 minutes ago'],
    [5 * 60_000, '5 минут назад', '5 minutes ago'],
    [11 * 60_000, '11 минут назад', '11 minutes ago'],
    [21 * 60_000, '21 минуту назад', '21 minutes ago'],
    [60 * 60_000 - 1, '59 минут назад', '59 minutes ago'],
    [60 * 60_000, '1 час назад', '1 hour ago'],
    [2 * 60 * 60_000, '2 часа назад', '2 hours ago'],
    [5 * 60 * 60_000, '5 часов назад', '5 hours ago'],
    [24 * 60 * 60_000 - 1, '23 часа назад', '23 hours ago'],
    [24 * 60 * 60_000, '1 день назад', '1 day ago'],
    [2 * 24 * 60 * 60_000, '2 дня назад', '2 days ago'],
    [5 * 24 * 60 * 60_000, '5 дней назад', '5 days ago'],
    [11 * 24 * 60 * 60_000, '11 дней назад', '11 days ago'],
    [21 * 24 * 60 * 60_000, '21 день назад', '21 days ago'],
  ];

  for (const [elapsed, ru, en] of cases) {
    const lastReset = { at: new Date(NOW - elapsed).toISOString() };
    const [resource] = providerResources({ ...signal, lastReset }, NOW);

    assert.equal(resource.summary, ru, `RU: ${elapsed} ms`);
    assert.equal(resource.translations.en.summary, en, `EN: ${elapsed} ms`);
  }
});

test('отсутствующая, неверная и будущая дата не становятся давностью сброса', () => {
  for (const at of [undefined, null, '', 'invalid', 0, new Date(NOW + 1).toISOString()]) {
    const [resource] = providerResources({ ...signal, lastReset: { at } }, NOW);

    assert.equal(resource.summary, 'Нет данных');
    assert.equal(resource.translations.en.summary, 'No data');
  }
});

test('устаревшая и отсутствующая информация явно помечаются на обоих языках', () => {
  const stale = providerResources({ ...signal, stale: true }, NOW);
  const missing = providerResources({ stale: true }, NOW);

  assert.equal(stale[0].summary, '6 дней назад');
  assert.equal(stale[0].translations.en.summary, '6 days ago');
  assert.ok(stale.every((resource) => resource.tone === 'warn' && resource.note.includes('устарели')));
  assert.ok(stale.every((resource) => resource.translations.en.note.includes('Stale data')));
  assert.match(stale[0].note, /получены 2026-11-04 01:00 UTC/);
  assert.equal(missing[0].summary, 'Нет данных');
  assert.equal(missing[0].translations.en.summary, 'No data');
  assert.equal(missing[1].summary, '— / —');
  assert.match(missing[0].note, /пока недоступен/);
});
