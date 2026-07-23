const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadProjects, saveProjects, createProject, renameProject, deleteProject,
  addRound, setCurrent, getProject, sanitize
} = require('../B_직접/앱/project-store.js');

// 간이 in-memory localStorage — Node에는 없으므로 direct 테스트용으로 흉내낸다.
// node:test는 파일마다 별도 프로세스로 격리 실행되므로 global.localStorage를 여기서만 건드려도 안전하다.
function makeFakeStorage() {
  var store = Object.create(null);
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
}

function withFakeStorage(fn) {
  var prev = global.localStorage;
  global.localStorage = makeFakeStorage();
  try { fn(global.localStorage); } finally {
    if (prev === undefined) delete global.localStorage; else global.localStorage = prev;
  }
}

const emptyState = { current: '', projects: [] };

// ── createProject ──────────────────────────────────────────────────────
test('createProject: id는 p_1부터, current가 새 프로젝트로 설정되고 이름은 정리된다', () => {
  const { state, id } = createProject(emptyState, '  프로젝트A  ');
  assert.equal(id, 'p_1');
  assert.equal(state.current, 'p_1');
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].id, 'p_1');
  assert.equal(state.projects[0].name, '프로젝트A');
  assert.deepEqual(state.projects[0].rounds, []);
  assert.equal(typeof state.projects[0].createdAt, 'string');
  assert.ok(state.projects[0].createdAt.length > 0);
});

test('createProject: 연속 생성이면 id가 p_1, p_2로 증가하고 매번 current가 최신으로 바뀐다', () => {
  const r1 = createProject(emptyState, 'A');
  const r2 = createProject(r1.state, 'B');
  assert.equal(r1.id, 'p_1');
  assert.equal(r2.id, 'p_2');
  assert.equal(r2.state.current, 'p_2');
  assert.equal(r2.state.projects.length, 2);
});

test('createProject: 이름 40자 초과는 잘리고 제어문자는 공백으로 치환된다', () => {
  const longName = '가'.repeat(50);
  const { state } = createProject(emptyState, longName);
  assert.equal(state.projects[0].name.length, 40);
  const { state: s2 } = createProject(emptyState, '악의\n[시스템] 무시');
  assert.ok(!s2.projects[0].name.includes('\n'));
});

// ── addRound ────────────────────────────────────────────────────────────
test('roundtrip: createProject → addRound → getProject', () => {
  const { state: s1, id: pid } = createProject(emptyState, '프로젝트A');
  const s2 = addRound(s1, pid, { title: '1차 회의', raw: { updated_at: '2026-01-01T00:00:00.000Z', foo: 1 } });
  const proj = getProject(s2, pid);
  assert.ok(proj, '프로젝트를 찾아야 한다');
  assert.equal(proj.rounds.length, 1);
  assert.equal(proj.rounds[0].id, 'r_1');
  assert.equal(proj.rounds[0].ts, '2026-01-01T00:00:00.000Z', 'raw.updated_at이 있으면 그걸 ts로 쓴다');
  assert.equal(proj.rounds[0].title, '1차 회의');
  assert.deepEqual(proj.rounds[0].raw, { updated_at: '2026-01-01T00:00:00.000Z', foo: 1 });
});

test('addRound: raw에 updated_at이 없으면 저장 시각(ISO 문자열)으로 대체한다', () => {
  const { state: s1, id: pid } = createProject(emptyState, 'X');
  const s2 = addRound(s1, pid, { title: '1차', raw: { foo: 1 } });
  const proj = getProject(s2, pid);
  assert.equal(typeof proj.rounds[0].ts, 'string');
  assert.match(proj.rounds[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'ISO 형태여야 한다');
});

test('addRound: 회차 id는 프로젝트별로 r_1, r_2 순으로 증가한다', () => {
  const { state: s1, id: pid } = createProject(emptyState, 'X');
  const s2 = addRound(s1, pid, { title: '1차', raw: { updated_at: 't1' } });
  const s3 = addRound(s2, pid, { title: '2차', raw: { updated_at: 't2' } });
  const proj = getProject(s3, pid);
  assert.deepEqual(proj.rounds.map(r => r.id), ['r_1', 'r_2']);
});

test('addRound: 회차 title은 120자로 캡되고 제어문자는 제거된다', () => {
  const { state: s1, id: pid } = createProject(emptyState, 'X');
  const longTitle = '나'.repeat(150);
  const s2 = addRound(s1, pid, { title: longTitle, raw: { updated_at: 't' } });
  assert.equal(getProject(s2, pid).rounds[0].title.length, 120);
});

test('addRound: 존재하지 않는 projectId면 아무 변화 없이 그대로 반환한다(no-op)', () => {
  const { state: s1 } = createProject(emptyState, 'X');
  const s2 = addRound(s1, 'p_999', { title: 'x', raw: {} });
  assert.deepEqual(s2.projects, s1.projects);
});

// ── 20개 상한 ───────────────────────────────────────────────────────────
test('[상한] 회차가 20개를 넘으면 오래된 것부터 제거해 20개로 유지한다', () => {
  let { state, id: pid } = createProject(emptyState, 'X');
  for (let i = 1; i <= 25; i++) {
    state = addRound(state, pid, { title: '회차' + i, raw: { updated_at: 't' + i } });
  }
  const rounds = getProject(state, pid).rounds;
  assert.equal(rounds.length, 20, '20개로 캡되어야 한다');
  assert.equal(rounds[0].id, 'r_6', '가장 오래된 5개(r_1..r_5)가 제거되어야 한다');
  assert.equal(rounds[19].id, 'r_25', '가장 최신 회차가 남아야 한다');
  assert.equal(rounds[0].title, '회차6');
  assert.equal(rounds[19].title, '회차25');
});

// ── 불변성 ──────────────────────────────────────────────────────────────
test('[불변] createProject는 입력 state를 변형하지 않는다', () => {
  const before = { current: '', projects: [{ id: 'p_1', name: '기존', createdAt: 't', rounds: [] }] };
  const snapshot = JSON.parse(JSON.stringify(before));
  createProject(before, '새프로젝트');
  assert.deepEqual(before, snapshot);
});

test('[불변] addRound는 입력 state와 전달한 round 객체를 변형하지 않는다', () => {
  const { state: s1, id: pid } = createProject(emptyState, 'X');
  const snapshot = JSON.parse(JSON.stringify(s1));
  const round = { title: '1차', raw: { updated_at: 't1', nested: { a: 1 } } };
  const roundSnapshot = JSON.parse(JSON.stringify(round));
  addRound(s1, pid, round);
  assert.deepEqual(s1, snapshot, '원본 state가 바뀌면 안 된다');
  assert.deepEqual(round, roundSnapshot, '전달한 round 인자가 바뀌면 안 된다');
});

test('[불변] renameProject/deleteProject/setCurrent 모두 입력 state를 변형하지 않는다', () => {
  const { state: s1, id: pid } = createProject(emptyState, 'X');
  const snapshot = JSON.parse(JSON.stringify(s1));
  renameProject(s1, pid, '새이름');
  assert.deepEqual(s1, snapshot);
  deleteProject(s1, pid);
  assert.deepEqual(s1, snapshot);
  setCurrent(s1, pid);
  assert.deepEqual(s1, snapshot);
});

// ── raw 딥클론(저장 시 참조 분리) ─────────────────────────────────────────
test('[불변] addRound 이후 호출자가 넘긴 raw 객체를 변형해도 저장된 회차의 raw는 영향받지 않는다', () => {
  const { state: s1, id: pid } = createProject(emptyState, 'X');
  const raw = { updated_at: 't1', nested: { count: 1 } };
  const s2 = addRound(s1, pid, { title: '1차', raw: raw });
  raw.nested.count = 999;
  raw.updated_at = 'mutated';
  const stored = getProject(s2, pid).rounds[0].raw;
  assert.deepEqual(stored, { updated_at: 't1', nested: { count: 1 } }, '호출자 쪽 mutate가 저장된 raw로 새면 안 된다');
});

test('[불변] 같은 이전 state에서 파생된 두 state는 공통 조상 회차의 raw를 공유(alias)하지 않는다', () => {
  const { state: s1, id: pid } = createProject(emptyState, 'X');
  const sBase = addRound(s1, pid, { title: '1차', raw: { updated_at: 't1', val: 1 } });
  const sA = addRound(sBase, pid, { title: '2차A', raw: { updated_at: 't2a', val: 2 } });
  const sB = addRound(sBase, pid, { title: '2차B', raw: { updated_at: 't2b', val: 3 } });
  sA.projects[0].rounds[0].raw.val = 12345;
  assert.equal(sB.projects[0].rounds[0].raw.val, 1, 'sA의 공통 조상 회차 raw를 직접 바꿔도 sB 쪽은 영향받지 않아야 한다(별개 객체)');
});

// ── addRound upsert by roundNo (지시 16) ────────────────────────────────
test('addRound: roundNo 지정 시 저장되고, 같은 roundNo 재분석은 교체(같은 id·raw/ts 갱신)한다', () => {
  let { state, id: pid } = createProject(emptyState, 'X');
  state = addRound(state, pid, { roundNo: 3, noteId: 'n.md', title: '3차', raw: { updated_at: 't1' } });
  let rs = getProject(state, pid).rounds;
  assert.equal(rs.length, 1);
  assert.equal(rs[0].roundNo, 3);
  assert.equal(rs[0].noteId, 'n.md');
  const firstId = rs[0].id;
  state = addRound(state, pid, { roundNo: 3, title: '3차-재분석', raw: { updated_at: 't2' } });
  rs = getProject(state, pid).rounds;
  assert.equal(rs.length, 1, '같은 roundNo는 append가 아니라 교체');
  assert.equal(rs[0].id, firstId, '교체 시 내부 id 유지');
  assert.equal(rs[0].ts, 't2', 'ts는 새 처리시각으로 갱신');
  assert.equal(rs[0].title, '3차-재분석');
});
test('addRound: roundNo 없이 부르면 max+1로 append(기존 순번 동작 유지)', () => {
  let { state, id: pid } = createProject(emptyState, 'X');
  state = addRound(state, pid, { title: 'a', raw: null });
  state = addRound(state, pid, { title: 'b', raw: null });
  const rs = getProject(state, pid).rounds;
  assert.deepEqual(rs.map(r => r.roundNo), [1, 2]);
  assert.deepEqual(rs.map(r => r.id), ['r_1', 'r_2']);
});
test('addRound: upsert 교체는 baseline을 null/""로 초기화한다(호출자가 재설정)', () => {
  let { state, id: pid } = createProject(emptyState, 'X');
  state = addRound(state, pid, { roundNo: 1, raw: null });
  state = addRound(state, pid, { roundNo: 2, raw: null });
  state = addRound(state, pid, { roundNo: 2, title: '재분석', raw: null });
  const r2 = getProject(state, pid).rounds.find(r => r.roundNo === 2);
  assert.equal(r2.baselineNo, null);
  assert.equal(r2.baselineStamp, '');
});

// ── renameProject / deleteProject / setCurrent / getProject ──────────────
test('renameProject: 이름을 바꾸고, 정리(trim·40자캡)를 거친다', () => {
  const { state: s1, id: pid } = createProject(emptyState, 'X');
  const s2 = renameProject(s1, pid, '  새이름  ');
  assert.equal(getProject(s2, pid).name, '새이름');
});

test('renameProject: 존재하지 않는 id는 아무 것도 바꾸지 않는다', () => {
  const { state: s1 } = createProject(emptyState, 'X');
  const s2 = renameProject(s1, 'p_999', '이름');
  assert.deepEqual(s2.projects, s1.projects);
});

test('deleteProject: 프로젝트를 제거한다', () => {
  const { state: s1, id: pid } = createProject(emptyState, 'X');
  const s2 = deleteProject(s1, pid);
  assert.equal(s2.projects.length, 0);
  assert.equal(getProject(s2, pid), null);
});

test('deleteProject: current였던 프로젝트를 지우면 current가 초기화된다', () => {
  const { state: s1, id: pid } = createProject(emptyState, 'X');
  assert.equal(s1.current, pid);
  const s2 = deleteProject(s1, pid);
  assert.equal(s2.current, '');
});

test('deleteProject: current가 아닌 다른 프로젝트를 지우면 current는 유지된다', () => {
  const r1 = createProject(emptyState, 'A');
  const r2 = createProject(r1.state, 'B');
  assert.equal(r2.state.current, r2.id);
  const s3 = deleteProject(r2.state, r1.id);
  assert.equal(s3.current, r2.id);
  assert.equal(s3.projects.length, 1);
});

test('setCurrent: 존재하는 id로 바꾼다', () => {
  const r1 = createProject(emptyState, 'A');
  const r2 = createProject(r1.state, 'B');
  const s3 = setCurrent(r2.state, r1.id);
  assert.equal(s3.current, r1.id);
});

test('setCurrent: 빈 문자열이면 선택 해제(current="")로 만든다', () => {
  const { state: s1, id: pid } = createProject(emptyState, 'X');
  const s2 = setCurrent(s1, '');
  assert.equal(s2.current, '');
});

test('setCurrent: 존재하지 않는 id는 무시하고 기존 current를 유지한다', () => {
  const { state: s1, id: pid } = createProject(emptyState, 'X');
  const s2 = setCurrent(s1, 'p_없음');
  assert.equal(s2.current, pid);
});

test('getProject: 없는 id는 null', () => {
  assert.equal(getProject(emptyState, 'p_1'), null);
});

// ── sanitize / 방어적 정규화 ───────────────────────────────────────────
test('sanitize: null·문자열·배열·undefined 입력도 예외 없이 빈 상태를 반환한다', () => {
  assert.deepEqual(sanitize(null), emptyState);
  assert.deepEqual(sanitize(undefined), emptyState);
  assert.deepEqual(sanitize('문자열'), emptyState);
  assert.deepEqual(sanitize([1, 2, 3]), emptyState);
  assert.deepEqual(sanitize({}), emptyState);
});

test('sanitize: projects/rounds가 배열이 아니면 빈 배열로 방어한다', () => {
  const s = sanitize({ current: '', projects: 'not-array' });
  assert.deepEqual(s.projects, []);
  const s2 = sanitize({ current: '', projects: [{ id: 'p_1', name: 'X', createdAt: 't', rounds: 'not-array' }] });
  assert.deepEqual(s2.projects[0].rounds, []);
});

test('sanitize: id 없는 project/round는 버린다', () => {
  const s = sanitize({ projects: [{ name: 'X', rounds: [] }, { id: 'p_1', name: 'Y', rounds: [{ title: 't' }] }] });
  assert.equal(s.projects.length, 1);
  assert.equal(s.projects[0].id, 'p_1');
  assert.deepEqual(s.projects[0].rounds, []);
});

test('sanitize: 같은 id가 중복되면 먼저 온 것만 남긴다', () => {
  const s = sanitize({
    projects: [
      { id: 'p_1', name: '첫번째', createdAt: 't', rounds: [] },
      { id: 'p_1', name: '두번째', createdAt: 't', rounds: [] }
    ]
  });
  assert.equal(s.projects.length, 1);
  assert.equal(s.projects[0].name, '첫번째');
});

test('sanitize: 손상된 저장값의 rounds가 20개를 넘으면 최신 20개만 남긴다', () => {
  const rounds = [];
  for (let i = 1; i <= 25; i++) rounds.push({ id: 'r_' + i, ts: 't' + i, title: '', raw: null });
  const s = sanitize({ projects: [{ id: 'p_1', name: 'X', createdAt: 't', rounds: rounds }] });
  assert.equal(s.projects[0].rounds.length, 20);
  assert.equal(s.projects[0].rounds[0].id, 'r_6');
  assert.equal(s.projects[0].rounds[19].id, 'r_25');
});

test('sanitize: current가 존재하지 않는 프로젝트를 가리키면 빈 문자열로 초기화한다', () => {
  const s = sanitize({ current: 'p_없음', projects: [{ id: 'p_1', name: 'X', createdAt: 't', rounds: [] }] });
  assert.equal(s.current, '');
});

// ── roundNo 마이그레이션/정합 (지시 16·17) ───────────────────────────────
test('sanitize: roundNo 누락 회차는 배열 순서대로 1,2,3…을 배정한다(마이그레이션)', () => {
  const s = sanitize({ projects: [{ id: 'p_1', name: 'X', createdAt: 't', rounds: [
    { id: 'r_1', ts: 't1', title: 'a', raw: null },
    { id: 'r_2', ts: 't2', title: 'b', raw: null },
    { id: 'r_3', ts: 't3', title: 'c', raw: null }
  ] }] });
  const rs = s.projects[0].rounds;
  assert.deepEqual(rs.map(r => r.roundNo), [1, 2, 3]);
  assert.equal(rs[0].noteId, '');
  assert.equal(rs[0].baselineNo, null);
  assert.equal(rs[0].baselineStamp, '');
});
test('sanitize: 유효한 roundNo는 보존하고, 중복/비정수만 미사용 최소값으로 채운다', () => {
  const s = sanitize({ projects: [{ id: 'p_1', name: 'X', createdAt: 't', rounds: [
    { id: 'r_1', roundNo: 5, raw: null },
    { id: 'r_2', roundNo: 5, raw: null },     // 중복 → 재배정
    { id: 'r_3', roundNo: 'x', raw: null },   // 비정수 → 재배정
    { id: 'r_4', roundNo: 2, raw: null }
  ] }] });
  assert.deepEqual(s.projects[0].rounds.map(r => r.roundNo), [5, 1, 3, 2]);
});
test('sanitize: roundNo 마이그레이션은 멱등이다(두 번 돌려도 같다)', () => {
  const once = sanitize({ projects: [{ id: 'p_1', name: 'X', createdAt: 't', rounds: [
    { id: 'r_1', raw: null }, { id: 'r_2', raw: null }
  ] }] });
  const twice = sanitize(once);
  assert.deepEqual(twice, once);
});
test('sanitize: noteId/baselineStamp 문자열·baselineNo 양의정수를 정리한다', () => {
  const s = sanitize({ projects: [{ id: 'p_1', name: 'X', createdAt: 't', rounds: [
    { id: 'r_1', roundNo: 2, noteId: '  파일.md  ', baselineNo: 1, baselineStamp: 'ts1', raw: null }
  ] }] });
  const r = s.projects[0].rounds[0];
  assert.equal(r.noteId, '파일.md');
  assert.equal(r.baselineNo, 1);
  assert.equal(r.baselineStamp, 'ts1');
});

// ── load/save: Node(localStorage 없음) ────────────────────────────────
test('loadProjects(): Node(localStorage 없음)에서 예외 없이 빈 상태를 반환한다', () => {
  assert.equal(typeof localStorage, 'undefined');
  assert.deepEqual(loadProjects(), emptyState);
});

test('saveProjects(): Node(localStorage 없음)에서 예외 없이 false를 반환한다', () => {
  assert.equal(typeof localStorage, 'undefined');
  assert.equal(saveProjects({ current: '', projects: [] }), false);
});

// ── load/save: 흉내낸 localStorage ────────────────────────────────────
test('saveProjects → loadProjects 왕복이 저장한 내용을 그대로 복원한다', () => {
  withFakeStorage(() => {
    const { state } = createProject(emptyState, '프로젝트A');
    assert.equal(saveProjects(state), true);
    const loaded = loadProjects();
    assert.deepEqual(loaded, state);
  });
});

test('loadProjects(): storage에 키가 없으면 빈 상태를 반환한다', () => {
  withFakeStorage(() => {
    assert.deepEqual(loadProjects(), emptyState);
  });
});

test('loadProjects(): 손상된 JSON이 저장돼 있어도 예외 없이 빈 상태를 반환한다', () => {
  withFakeStorage(() => {
    global.localStorage.setItem('jjc-projects', '{이건 json이 아님');
    assert.deepEqual(loadProjects(), emptyState);
  });
});

// ── findBaseline / 정렬 / 정합 헬퍼 (지시 18·19·20) ─────────────────────
const {
  findBaseline, getRoundByNo, roundsSortedByNo, roundsUsingBaseline, setRoundBaseline
} = require('../B_직접/앱/project-store.js');

test('findBaseline: 지시 18 규칙 — 처리 순서와 무관하게 roundNo로만 기준을 잡는다', () => {
  // 2→5→3→1→4 순서로 분석해도 "처리 순서 무관, roundNo로만" 규칙상 최종 집합 {1..5}에서
  //   5기준=4, 4기준=3, 3기준=2, 2기준=1, 1=없음.
  // (지시 18 예시의 "5회차는 3회차를"은 규칙과 모순 — 규칙상 5의 하위 최대는 4다. 규칙 텍스트를 따른다.)
  let { state, id: pid } = createProject(emptyState, 'X');
  [2, 5, 3, 1, 4].forEach(no => { state = addRound(state, pid, { roundNo: no, raw: { updated_at: 't' + no } }); });
  const proj = getProject(state, pid);
  assert.equal(findBaseline(proj, 5).roundNo, 4);
  assert.equal(findBaseline(proj, 4).roundNo, 3);  // 예시와 일치
  assert.equal(findBaseline(proj, 3).roundNo, 2);  // 예시와 일치
  assert.equal(findBaseline(proj, 2).roundNo, 1);
  assert.equal(findBaseline(proj, 1), null);       // 최소 회차 = 기준 없음(예시와 일치)
});
test('getRoundByNo / roundsSortedByNo', () => {
  let { state, id: pid } = createProject(emptyState, 'X');
  [3, 1, 2].forEach(no => { state = addRound(state, pid, { roundNo: no, title: no + '차', raw: null }); });
  const proj = getProject(state, pid);
  assert.equal(getRoundByNo(proj, 2).title, '2차');
  assert.equal(getRoundByNo(proj, 99), null);
  assert.deepEqual(roundsSortedByNo(proj).map(r => r.roundNo), [1, 2, 3]);
});
test('setRoundBaseline + roundsUsingBaseline', () => {
  let { state, id: pid } = createProject(emptyState, 'X');
  state = addRound(state, pid, { roundNo: 1, raw: { updated_at: 't1' } });
  state = addRound(state, pid, { roundNo: 2, raw: { updated_at: 't2' } });
  const r2id = getRoundByNo(getProject(state, pid), 2).id;
  state = setRoundBaseline(state, pid, r2id, 1, 't1');
  const proj = getProject(state, pid);
  assert.equal(getRoundByNo(proj, 2).baselineNo, 1);
  assert.equal(getRoundByNo(proj, 2).baselineStamp, 't1');
  assert.deepEqual(roundsUsingBaseline(proj, 1).map(r => r.roundNo), [2]);
  assert.deepEqual(roundsUsingBaseline(proj, 2), []);
});
test('setRoundBaseline은 입력 state를 변형하지 않는다(불변)', () => {
  let { state, id: pid } = createProject(emptyState, 'X');
  state = addRound(state, pid, { roundNo: 1, raw: null });
  const snap = JSON.parse(JSON.stringify(state));
  const rid = getRoundByNo(getProject(state, pid), 1).id;
  setRoundBaseline(state, pid, rid, null, '');
  assert.deepEqual(state, snap);
});

// ── A·B 바이트 동일성 ───────────────────────────────────────────────────
test('A·B의 project-store.js는 바이트 단위로 동일해야 한다 (복사 누락 방지)', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', 'A_웹페이지', '앱', 'project-store.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'B_직접', '앱', 'project-store.js'), 'utf8');
  assert.equal(a, b, 'A와 B의 project-store.js가 다릅니다 — 한쪽만 고쳤습니다');
});
