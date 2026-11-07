import { HOMEPAGE } from './source.js';

const relativeFormatters = {
  ru: new Intl.RelativeTimeFormat('ru', { numeric: 'always' }),
  en: new Intl.RelativeTimeFormat('en', { numeric: 'always' }),
};

function resetAge(value, now, locale) {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  const elapsed = now - at;

  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return '';
  }

  const minutes = Math.floor(elapsed / 60_000);

  if (minutes === 0) {
    return locale === 'ru' ? 'только что' : 'just now';
  }

  const formatter = relativeFormatters[locale];

  if (minutes >= 24 * 60) {
    return formatter.format(-Math.floor(minutes / (24 * 60)), 'day');
  }
  if (minutes >= 60) {
    return formatter.format(-Math.floor(minutes / 60), 'hour');
  }

  return formatter.format(-minutes, 'minute');
}

function dateLabel(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
    : '';
}

function percentage(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? `${Math.round(value)} %`
    : '—';
}

/**
 * Прогноз становится строками существующего popup, а не отдельной страницей.
 * Переводы едут с данными; давность источника и экспериментальность оценки видны всегда.
 */
export function providerResources(signal, now = Date.now()) {
  const resetRu = resetAge(signal.lastReset?.at, now, 'ru');
  const resetEn = resetAge(signal.lastReset?.at, now, 'en');
  const fetched = dateLabel(signal.fetchedAt);
  const staleRu = signal.stale
    ? fetched ? `Данные устарели · получены ${fetched}.` : 'Источник пока недоступен.'
    : '';
  const staleEn = signal.stale
    ? fetched ? `Stale data · fetched ${fetched}.` : 'Source data is not available yet.'
    : '';
  const lastRu = ['Общий сброс по данным сайта.', staleRu].filter(Boolean).join(' ');
  const lastEn = ['Shared reset reported by the website.', staleEn].filter(Boolean).join(' ');
  const forecastRu = ['Оценка codexreset.org, не гарантия сброса.', staleRu].filter(Boolean).join(' ');
  const forecastEn = ['Estimate by codexreset.org, not a guaranteed reset.', staleEn]
    .filter(Boolean).join(' ');

  return [{
    key: 'last-reset',
    label: 'codexreset.org',
    summary: resetRu || 'Нет данных',
    note: lastRu,
    tone: signal.stale ? 'warn' : 'muted',
    translations: {
      en: { summary: resetEn || 'No data', note: lastEn },
    },
    controls: [{
      id: 'source',
      kind: 'link',
      label: 'codexreset.org',
      href: HOMEPAGE,
    }],
  }, {
    key: 'forecast',
    label: 'Прогноз · 24 / 48 ч',
    summary: `${percentage(signal.chance24h)} / ${percentage(signal.chance48h)}`,
    note: forecastRu,
    tone: signal.stale ? 'warn' : 'muted',
    translations: {
      en: { label: 'Forecast · 24 / 48 h', note: forecastEn },
    },
  }];
}
