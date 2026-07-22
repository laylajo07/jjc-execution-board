// TS 러너의 부서 프롬프트 사본(dept-prompt.ts)을 공용 fixture로 고정한다.
// JS 사본은 테스트/board-custom.test.js, Python 사본은 테스트/stream_parse_test.py 가 같은 fixture로 핀한다.
// 실행: 러너/ts 에서  `npm test`  (= tsx --test dept-prompt.test.ts)
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deptConfigToPrompt } from './dept-prompt.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '..', '..', '테스트', 'fixtures', 'dept-config-prompt-cases.json');

type Case = { name: string; config: unknown; expected: string };
const cases: Case[] = JSON.parse(readFileSync(FIXTURE, 'utf-8'));

test('fixture: TS deptConfigToPrompt(config) === expected (JS/Python 사본과 문구·규칙 동일)', () => {
  assert.ok(cases.length > 0, 'fixture가 비어있으면 안 된다');
  for (const { name, config, expected } of cases) {
    assert.equal(deptConfigToPrompt(config), expected, `케이스 "${name}" 불일치`);
  }
});
