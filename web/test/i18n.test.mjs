// The start page's languages (web/src/app/i18n.ts):
//   node --test web/test/i18n.test.mjs
// 1. Every text the page shows is one the extraction reads (web/tools/i18n-keys.mjs): N() and tn() of literals only.
// 2. Every language's file (web/src/app/lang/<language>.json) has every text in use and nothing else, each with the
//    English's {name}s (a plural's one form may say {n} in words) and <n> tags, plural forms of its own language.
//    A new or changed English text fails here until each language has it: `node web/tools/i18n-keys.mjs <language>`
//    lists what one lacks, `node web/tools/i18n-keys.mjs --check` what is wrong.
// 3. t(), tn() and tvars() as the page calls them: English as written, a language's text and plural forms once its
//    file is in (fetched, as the page fetches /lang/<language>.json), English for a text the file lacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { catalog, check, langFile, LANGUAGE_FILES } from '../tools/i18n-keys.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { keys, bad } = catalog();

test('the texts in use are literals the extraction reads', () => {
  assert.deepEqual(bad, []);
  assert.ok(keys.size > 500, `${keys.size} texts`);
  assert.ok(keys.has('Fan project. Not affiliated with or endorsed by Electronic Arts.'), 'index.html data-i18n');
  assert.ok(keys.has('Post the log in <0>#bug-reports on our Discord</0>, with what you were doing.'), 'index.html data-i18n-html');
  assert.ok(keys.get('{n} laps')?.plural, 'tn()');
});

// Greek is optional; untranslated strings intentionally fall back to English.
for (const lang of LANGUAGE_FILES.filter(lang => lang !== 'greek')) {
  test(`${lang}: every text, as the English has it`, () => {
    assert.ok(fs.existsSync(langFile(lang)), `web/src/app/lang/${lang}.json`);
    assert.deepEqual(check(lang, keys), []);
  });
}

test('t(), tn() and tvars(): English, then a language\'s text and plural forms', async () => {
  const out = await esbuild.build({ entryPoints: [path.join(HERE, '../src/app/i18n.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral' });
  const I = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
  assert.deepEqual([...I.LANGUAGES].filter(l => l !== 'english').sort(), [...LANGUAGE_FILES].sort());
  for (const l of I.LANGUAGES) assert.ok(I.LOCALE[l] && I.NATIVE[l], l);
  assert.equal(I.t('Saved: {what}, {value}.', { what: 'Movies', value: 'off' }), 'Saved: Movies, off.');
  assert.equal(I.tn(1, '{n} lap', '{n} laps'), '1 lap');
  assert.equal(I.tn(5, '{n} lap', '{n} laps'), '5 laps');
  const pl = { '{n} laps': { one: '{n} okrążenie', few: '{n} okrążenia', many: '{n} okrążeń', other: '{n} okrążenia' }, 'the browser': 'przeglądarka',
    'Saved: {what}, {value}.': 'Zapisano: {what}, {value}.', '{Browser} asks': '{Browser} pyta' };
  globalThis.fetch = async url => ({ ok: url === '/lang/polish.json', status: 404, json: async () => pl });
  const log = [];
  assert.equal(await I.setLanguage('polish', s => log.push(s)), true);
  assert.equal(I.language(), 'polish');
  assert.equal(I.tn(1, '{n} lap', '{n} laps'), '1 okrążenie');
  assert.equal(I.tn(3, '{n} lap', '{n} laps'), '3 okrążenia');
  assert.equal(I.tn(5, '{n} lap', '{n} laps'), '5 okrążeń');
  assert.equal(I.t('Saved: {what}, {value}.', { what: 'Filmy', value: 'wyłączone' }), 'Zapisano: Filmy, wyłączone.');
  assert.equal(I.t('Not in the file'), 'Not in the file');
  assert.equal(I.tvars('{Browser} asks', { Browser: 'the browser' }), 'przeglądarka pyta');
  assert.equal(I.listOf(['a', 'b', 'c']), 'a, b i c');
  // a file that does not load leaves the page as it was
  assert.equal(await I.setLanguage('german', s => log.push(s)), false);
  assert.equal(I.language(), 'polish');
  assert.match(log.join('\n'), /german texts did not load \(Error: HTTP 404\)/);
  assert.equal(await I.setLanguage('english'), true);
  assert.equal(I.tn(5, '{n} lap', '{n} laps'), '5 laps');
  assert.equal(I.listOf(['a', 'b', 'c']), 'a, b and c');
});
