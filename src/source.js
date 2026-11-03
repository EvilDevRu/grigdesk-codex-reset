// С сайта читаются только скалярные данные сериализованного состояния.
// Скрипты, HTML и ссылки источника никогда не исполняются.
export const HOMEPAGE = 'https://codexreset.org/';
export const TTL_MS = 60 * 60_000;
export const TIMEOUT_MS = 15_000;
export const MAX_BYTES = 2 * 1024 * 1024;

const SOURCE_HOSTS = new Set(['x.com', 'twitter.com', 'openai.com', 'status.openai.com']);
const RESET_KINDS = new Set(['forced-reset', 'compensation']);
const SCALAR = /^([A-Za-z][A-Za-z0-9]*):\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|null)$/s;

/**
 * Находит только скалярные поля верхнего уровня объекта сериализатора.
 * Вложенные объекты и запятые/скобки внутри строк не меняют границы полей.
 */
function fieldsAt(text, start) {
  const fields = new Map();
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let segment = start + 1;

  for (let index = start; index < Math.min(text.length, start + 256 * 1024); index += 1) {
    const char = text[index];

    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quoted = false;
      }

      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }

    if (depth === 1 && (char === ',' || char === '}')) {
      const match = SCALAR.exec(text.slice(segment, index).trim());

      if (match) {
        try {
          fields.set(match[1], JSON.parse(match[2]));
        } catch {
          return null;
        }
      }

      segment = index + 1;
    }

    if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
    }

    if (depth === 0) {
      return fields;
    }
  }

  return null;
}

function plainText(value) {
  return typeof value === 'string'
    ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
    : '';
}

/**
 * Ссылка на доказательство допускает только HTTPS и известные хосты.
 * Учётные данные, нестандартный порт и похожие имена доменов отбрасываются.
 */
function sourceUrl(value) {
  try {
    const url = new URL(value);

    if (url.protocol === 'https:' && SOURCE_HOSTS.has(url.hostname)
      && !url.username && !url.password && !url.port) {
      return url.href;
    }
  } catch {
    return null;
  }

  return null;
}

function chance(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

/**
 * Восстанавливает последний состоявшийся сброс и прямые оценки сайта.
 * Назначения $R[n] нового сериализатора поддержаны без eval и без запуска страницы.
 */
export function parsePage(html, now = Date.now()) {
  let lastReset = null;

  for (const match of html.matchAll(/\{id:"reset:(?:[^"\\]|\\.)*"/g)) {
    const fields = fieldsAt(html, match.index);

    if (!fields || !RESET_KINDS.has(fields.get('type'))) {
      continue;
    }

    const stamp = fields.get('dateTime');
    const at = typeof stamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(stamp)
      ? Date.parse(stamp)
      : Number.NaN;

    if (!Number.isFinite(at) || at > now || (lastReset && at <= Date.parse(lastReset.at))) {
      continue;
    }

    lastReset = {
      at: new Date(at).toISOString(),
      title: plainText(fields.get('title')),
      scope: plainText(fields.get('scope')),
      sourceLabel: plainText(fields.get('sourceLabel')),
      sourceUrl: sourceUrl(fields.get('sourceUrl')),
    };
  }

  const forecast = /,forecast:\s*(?:\$R\[\d+\]=)?\{/.exec(html);
  const fields = forecast ? fieldsAt(html, forecast.index + forecast[0].lastIndexOf('{')) : null;

  return {
    lastReset,
    chance24h: chance(fields?.get('score24h')),
    chance48h: chance(fields?.get('score48h')),
  };
}

/**
 * Читает поток с ограничением по фактическим байтам, включая распакованный ответ.
 * Content-Length используется только для раннего отказа, таймаут охватывает и тело.
 */
async function readHtml(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();

    throw new Error('response_too_large');
  }

  const chunks = [];
  let size = 0;

  if (!response.body) {
    throw new Error('invalid_page');
  }

  for await (const chunk of response.body) {
    signal.throwIfAborted();
    size += chunk.byteLength;

    if (size > MAX_BYTES) {
      throw new Error('response_too_large');
    }

    chunks.push(chunk);
  }

  signal.throwIfAborted();

  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * Хранит последний успешный снимок, объединяет запросы и ограничивает повторы.
 * Отказ сразу помечает сохранённые данные устаревшими; выключение отзывает запрос.
 */
export function createSource({ fetchImpl = fetch, now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  let good = null;
  let error = null;
  let triedAt = null;
  let inflight = null;
  let controller = null;
  let stopped = false;
  let generation = 0;

  /**
   * Возвращает снимок памяти и пересчитывает его свежесть без сетевых эффектов.
   * Копия записи сброса не позволяет потребителю изменить внутренний кэш.
   */
  function peek() {
    const at = now();

    return {
      providerId: 'codex',
      source: 'codexreset.org',
      homepage: HOMEPAGE,
      fetchedAt: good ? new Date(good.at).toISOString() : null,
      checkedAt: triedAt === null ? null : new Date(triedAt).toISOString(),
      stale: !good || Boolean(error) || at - good.at >= TTL_MS,
      error,
      lastReset: good?.parsed.lastReset ? { ...good.parsed.lastReset } : null,
      chance24h: good?.parsed.chance24h ?? null,
      chance48h: good?.parsed.chance48h ?? null,
    };
  }

  /**
   * Запрос всегда идёт на фиксированную главную без перенаправлений и секретов.
   * Ошибки транспорта преобразуются в коды, чужой текст ошибок наружу не передаётся.
   */
  async function request() {
    const owner = generation;

    triedAt = now();
    controller = new AbortController();

    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);

    try {
      const response = await fetchImpl(HOMEPAGE, {
        headers: { accept: 'text/html', 'user-agent': 'GrigDesk Codex Reset/0.1' },
        redirect: 'error',
        signal,
      });

      if (!response.ok) {
        await response.body?.cancel();

        throw new Error('http_error');
      }

      const parsed = parsePage(await readHtml(response, signal), now());

      signal.throwIfAborted();

      if (owner !== generation) {
        return;
      }

      if (!parsed.lastReset && parsed.chance24h === null && parsed.chance48h === null) {
        throw new Error('invalid_page');
      }

      good = { at: now(), parsed };
      error = null;
    } catch (cause) {
      if (stopped || owner !== generation) {
        return;
      }

      const known = ['http_error', 'invalid_page', 'response_too_large'];

      error = signal.aborted ? 'timeout' : known.includes(cause?.message) ? cause.message : 'network_error';
    } finally {
      controller = null;
    }
  }

  /**
   * Объединяет читателей одной загрузки и учитывает TTL с паузой после ошибки.
   * При остановке возвращает сохранённый снимок, не открывая новый запрос.
   */
  async function read() {
    if (stopped) {
      return peek();
    }

    if (inflight) {
      await inflight;

      return peek();
    }

    const fresh = good && now() - good.at < TTL_MS && !error;
    const cooling = triedAt !== null && now() - triedAt < TTL_MS / 10;

    if (!fresh && !cooling) {
      inflight = request().finally(() => {
        inflight = null;
      });
      await inflight;
    }

    return peek();
  }

  /**
   * Отзывает сетевой запрос и поколение, затем ожидает его освобождения.
   * Отменённая попытка не мешает новому запуску шестиминутной паузой.
   */
  async function stop() {
    stopped = true;
    generation += 1;

    if (inflight) {
      triedAt = null;
    }

    controller?.abort();
    await inflight;
  }

  function resume() {
    stopped = false;
  }

  return {
    read,
    peek,
    stop,
    resume,
  };
}
