import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOTS = ['.gitignore', 'README.md', 'CHANGELOG.md', 'package.json', 'plugin.json',
  'server.js', 'src', 'docs', 'integration', 'scripts', 'tests'];

/**
 * Собирает явный состав поставки, исключая Git и рабочие данные.
 * Ссылки и специальные файлы отклоняются до упаковки, а не следуют за пределы проекта.
 */
export async function releaseFiles(root = PACKAGE_ROOT) {
  const files = [];

  /**
   * Обходит только выбранную часть поставки по обычным каталогам.
   * Проверка lstat предшествует чтению, чтобы не пройти по ссылке наружу.
   */
  async function visit(relative) {
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);

    assert.ok(!info.isSymbolicLink(), `Ссылка в поставке: ${relative}`);

    if (info.isDirectory()) {
      const names = await readdir(absolute);

      for (const name of names.sort()) {
        assert.ok(!name.startsWith('.'), `Скрытый файл внутри поставки: ${name}`);
        await visit(path.join(relative, name));
      }
    } else {
      assert.ok(info.isFile(), `Специальный файл в поставке: ${relative}`);
      files.push(relative);
    }
  }

  for (const relative of ROOTS) {
    await visit(relative);
  }

  return files.sort();
}

/**
 * Сверяет версию и контракт фонового пакета перед выпуском.
 * Проверка не обращается к сети, не создаёт теги и не меняет рабочую установку.
 */
export async function checkRelease(root = PACKAGE_ROOT) {
  const json = async (name) => JSON.parse(await readFile(path.join(root, name), 'utf8'));
  const manifest = await json('plugin.json');
  const pkg = await json('package.json');
  const files = await releaseFiles(root);

  assert.equal(manifest.id, 'codex-reset');
  assert.equal(manifest.api, 2);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, manifest.version, 'Версии package.json и plugin.json расходятся');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true, 'Плагин публикуется через Git, а не npm registry');

  for (const key of ['web', 'webModule', 'nav', 'placements']) {
    assert.equal(manifest[key], undefined, `Фоновый плагин не объявляет ${key}`);
  }

  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(Object.keys(pkg[key] ?? {}).length, 0, 'Пакет не требует установки зависимостей');
  }

  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const icon = await readFile(path.join(root, 'docs/assets/codex-reset.svg'), 'utf8');

  assert.ok(readme.includes(`Версия ${manifest.version}`), 'Версия README расходится с манифестом');
  assert.ok(changelog.includes(`## ${manifest.version}`), 'Нет записи версии в CHANGELOG');
  assert.match(readme, /src="docs\/assets\/codex-reset\.svg"/);
  assert.match(icon, /viewBox="0 0 24 24"/);
  assert.match(icon, /<title\b/);
  assert.doesNotMatch(icon, /<(?:script|image|foreignObject)\b|\bon\w+\s*=|(?:href|src)\s*=/i);

  const server = await import(pathToFileURL(path.join(root, 'server.js')).href);

  assert.equal(typeof server.default, 'function', 'Серверный вход должен экспортировать функцию');

  return { version: manifest.version, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkRelease();

  console.log(`Codex Reset ${result.version}: поставка проверена, файлов ${result.files.length}.`);
}
