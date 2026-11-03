import { createSource } from './src/source.js';

const PLUGIN_ID = 'codex-reset';
const TICK_MS = 60_000;

/**
 * Серверный плагин API 2 без браузерного кода и собственной навигации.
 * Работает при закрытых окнах, останавливает сеть и таймер при выключении/замене.
 */
export default async function codexResetPlugin(app, options = {}) {
  const source = createSource(options.sourceOptions);
  let timer = null;
  let enabled = true;
  let closed = false;
  let revision = 0;
  let published = null;

  /**
   * Читает общий кэш и публикует только новый снимок текущего поколения.
   * Одновременные читатели не порождают повторных событий одного результата.
   */
  async function refresh() {
    const current = revision;
    const signal = await source.read();
    const serialized = JSON.stringify(signal);

    if (!closed && enabled && current === revision && published !== serialized) {
      options.core?.emit?.('signal', signal);
      published = serialized;
    }

    return signal;
  }

  /**
   * Минутный тик проверяет TTL, но успешная загрузка выполняется раз в час.
   * Первый запрос не задерживает запуск GrigDesk и не держит процесс открытым.
   */
  function start() {
    if (closed || timer) {
      return;
    }

    enabled = true;
    source.resume();
    timer = setInterval(() => {
      void refresh().catch((cause) => app.log.warn({ err: cause }, 'Codex Reset: сбой публикации'));
    }, TICK_MS);
    timer.unref();
    void refresh().catch((cause) => app.log.warn({ err: cause }, 'Codex Reset: сбой публикации'));
  }

  /**
   * Закрывает публикацию до ожидания отмены сетевого запроса.
   * Завершившийся позднее читатель не отправит событие выключенного плагина.
   */
  async function stop() {
    enabled = false;
    revision += 1;
    clearInterval(timer);
    timer = null;
    await source.stop();
  }

  if (options.lifecycle) {
    options.lifecycle.onDisable = stop;
    options.lifecycle.onEnable = start;
  }

  app.addHook('onReady', async () => {
    start();
  });
  app.addHook('onClose', async () => {
    closed = true;
    await stop();
  });

  app.get('/status', async () => ({
    pluginId: PLUGIN_ID,
    api: 2,
    ...source.peek(),
  }));
  app.get('/signal', async () => refresh());
}
