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

test('ресурсы popup сохраняют нулевую оценку, дату UTC и атрибуцию', () => {
  const resources = providerResources(signal);

  assert.equal(resources[0].summary, '2026-10-28 06:29 UTC');
  assert.equal(resources[0].controls[0].href, 'https://codexreset.org/');
  assert.equal(resources[1].summary, '0 % / 50 %');
  assert.match(resources[1].note, /не гарантия/);
  assert.match(resources[1].translations.en.note, /not a guaranteed reset/);
});

test('устаревшая и отсутствующая информация явно помечаются на обоих языках', () => {
  const stale = providerResources({ ...signal, stale: true });
  const missing = providerResources({ stale: true });

  assert.ok(stale.every((resource) => resource.tone === 'warn' && resource.note.includes('устарели')));
  assert.ok(stale.every((resource) => resource.translations.en.note.includes('Stale data')));
  assert.equal(missing[0].summary, 'Нет данных');
  assert.equal(missing[0].translations.en.summary, 'No data');
  assert.equal(missing[1].summary, '— / —');
  assert.match(missing[0].note, /пока недоступен/);
});
