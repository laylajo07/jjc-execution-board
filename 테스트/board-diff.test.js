const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { diffBoards, changeDigest } = require('../B_직접/앱/board-diff.js');

// board-diff.js가 반환하는 key 포맷은 헤더 주석에 문서화된 공개 계약:
// '<deptIdx>::<dept>::<kind(action|decision)>::<idx>'
// (deptIdx는 by_department 배열 내 0-based 순번, idx는 그 부서·kind 배열 내 0-based 순번)
// 이 파일의 기존 테스트는 전부 부서 1개짜리 board라 deptIdx=0 고정.
function key(deptIdx, dept, kind, idx) { return deptIdx + '::' + dept + '::' + kind + '::' + idx; }

function board(depts) {
  return { meeting: { title: '테스트', date: '2026-07-21' }, by_department: depts, sequence: [], gaps: [] };
}

function dept(name, actionItems, decisions, documents) {
  return { dept: name, action_items: actionItems || [], documents: documents || [], decisions_needed: decisions || [], _rd: [] };
}

function action(what, owner, due, status) {
  return { what: what, owner: owner || '', due: due || '', status: status || '', basis: '' };
}

function decision(topic, decider, due, status) {
  return { topic: topic, decider: decider || '', due: due || '', status: status || '', precondition: '' };
}

function document(doc, owner, due, status) {
  return { doc: doc, owner: owner || '', due: due || '', purpose: '', status: status || '' };
}

function snapshot(b) { return JSON.stringify(b); }

// ---------------------------------------------------------------------------
// 1. 신규 — cur에만 있고 prev에 매칭 없음
// ---------------------------------------------------------------------------

test('신규: prev에 없는 cur 항목은 new 태그', () => {
  const prev = board([dept('CB본부', [action('모델 재학습', 'CB1', '07-30', '진행중')])]);
  const cur = board([dept('CB본부', [
    action('모델 재학습', 'CB1', '07-30', '진행중'),
    action('예산 편성 검토', 'CB2', '08-05', '')
  ])]);
  const out = diffBoards(prev, cur);
  assert.equal(out.tags[key(0, 'CB본부', 'action', 0)], 'same');
  assert.equal(out.tags[key(0, 'CB본부', 'action', 1)], 'new');
});

// ---------------------------------------------------------------------------
// 2. 변경 — owner/due/status 중 하나라도 다르면 changed
// ---------------------------------------------------------------------------

test('변경: owner만 달라져도 changed', () => {
  const prev = board([dept('CB본부', [action('모델 재학습', 'CB1', '07-30', '진행중')])]);
  const cur = board([dept('CB본부', [action('모델 재학습', 'CB2', '07-30', '진행중')])]);
  const out = diffBoards(prev, cur);
  assert.equal(out.tags[key(0, 'CB본부', 'action', 0)], 'changed');
});

test('변경: due만 달라져도 changed', () => {
  const prev = board([dept('CB본부', [action('모델 재학습', 'CB1', '07-30', '진행중')])]);
  const cur = board([dept('CB본부', [action('모델 재학습', 'CB1', '08-10', '진행중')])]);
  const out = diffBoards(prev, cur);
  assert.equal(out.tags[key(0, 'CB본부', 'action', 0)], 'changed');
});

test('변경: status만 달라져도(확정이 아닌 경우) changed', () => {
  const prev = board([dept('CB본부', [action('모델 재학습', 'CB1', '07-30', '진행중')])]);
  const cur = board([dept('CB본부', [action('모델 재학습', 'CB1', '07-30', '검토중')])]);
  const out = diffBoards(prev, cur);
  assert.equal(out.tags[key(0, 'CB본부', 'action', 0)], 'changed');
});

test('의사결정 항목도 decider/due/status 변경을 changed로 잡는다', () => {
  const prev = board([dept('경영본부', [], [decision('가격정책', '경영1', '07-30', '확인필요')])]);
  const cur = board([dept('경영본부', [], [decision('가격정책', '경영2', '07-30', '확인필요')])]);
  const out = diffBoards(prev, cur);
  assert.equal(out.tags[key(0, '경영본부', 'decision', 0)], 'changed');
});

// ---------------------------------------------------------------------------
// 3. 불변 — 매칭되고 owner/due/status 모두 동일하면 태그 없음(same)
// ---------------------------------------------------------------------------

test('동일: owner/due/status 모두 같으면 same', () => {
  const prev = board([dept('CB본부', [action('모델 재학습', 'CB1', '07-30', '진행중')])]);
  const cur = board([dept('CB본부', [action('모델 재학습', 'CB1', '07-30', '진행중')])]);
  const out = diffBoards(prev, cur);
  assert.equal(out.tags[key(0, 'CB본부', 'action', 0)], 'same');
});

// ---------------------------------------------------------------------------
// 4. 완료 — status가 확정으로 바뀜(매칭) → cur 항목에 done 태그 + done[]에 reason:'confirmed'
// ---------------------------------------------------------------------------

test('완료: 매칭된 항목의 status가 확정으로 바뀌면 done 태그 + done[]에 confirmed로 기록', () => {
  const prev = board([dept('CB본부', [action('모델 재학습', 'CB1', '07-30', '진행중')])]);
  const cur = board([dept('CB본부', [action('모델 재학습', 'CB1', '07-30', '확정')])]);
  const out = diffBoards(prev, cur);
  assert.equal(out.tags[key(0, 'CB본부', 'action', 0)], 'done');
  assert.equal(out.done.length, 1);
  assert.equal(out.done[0].reason, 'confirmed');
  assert.equal(out.done[0].dept, 'CB본부');
  assert.equal(out.done[0].kind, 'action');
  assert.equal(out.done[0].idx, 0);
  assert.equal(out.done[0].status, '확정');
});

test('완료: 이미 확정이었고 계속 확정이면(전이 아님) done이 아니라 same', () => {
  const prev = board([dept('CB본부', [action('모델 재학습', 'CB1', '07-30', '확정')])]);
  const cur = board([dept('CB본부', [action('모델 재학습', 'CB1', '07-30', '확정')])]);
  const out = diffBoards(prev, cur);
  assert.equal(out.tags[key(0, 'CB본부', 'action', 0)], 'same');
  assert.equal(out.done.length, 0);
});

// ---------------------------------------------------------------------------
// 5. 완료 — prev 항목이 cur에 매칭 없이 사라짐(dropped) → done[]에 reason:'dropped'
// ---------------------------------------------------------------------------

test('완료: prev에만 있던 항목(cur에서 사라짐)은 done[]에 dropped로 기록', () => {
  const prev = board([dept('CB본부', [
    action('모델 재학습', 'CB1', '07-30', '진행중'),
    action('레거시 정리', 'CB2', '08-01', '')
  ])]);
  const cur = board([dept('CB본부', [action('모델 재학습', 'CB1', '07-30', '진행중')])]);
  const out = diffBoards(prev, cur);
  assert.equal(out.done.length, 1);
  assert.equal(out.done[0].reason, 'dropped');
  assert.equal(out.done[0].dept, 'CB본부');
  assert.equal(out.done[0].text, '레거시 정리');
  // 남은 항목은 same으로 정상 매칭
  assert.equal(out.tags[key(0, 'CB본부', 'action', 0)], 'same');
});

// ---------------------------------------------------------------------------
// 6. 첫 회차 — prev가 null이면 전부 same, new 아님
// ---------------------------------------------------------------------------

test('첫 회차: prevBoard가 null이면 cur 전부 same이고 new는 하나도 없다', () => {
  const cur = board([dept('CB본부', [action('모델 재학습', 'CB1', '07-30', '진행중')], [decision('가격정책', '경영1', '07-30', '')])]);
  const out = diffBoards(null, cur);
  assert.equal(out.tags[key(0, 'CB본부', 'action', 0)], 'same');
  assert.equal(out.tags[key(0, 'CB본부', 'decision', 0)], 'same');
  assert.ok(!Object.values(out.tags).includes('new'), '첫 회차는 비교 대상이 없으므로 new가 없어야 한다');
  assert.deepEqual(out.done, []);
});

// ---------------------------------------------------------------------------
// 7. 퍼지 매칭 — 살짝 다시 쓴 항목도 임계 0.6 이상이면 매칭된다
// ---------------------------------------------------------------------------

test('퍼지 매칭: 문구가 살짝 늘어나도(접두 보존) 같은 항목으로 매칭돼 same/changed로 잡힌다(new 아님)', () => {
  const prev = board([dept('법무실', [action('대체데이터 검토의견 작성', '법무1', '07-25', '진행중')])]);
  const cur = board([dept('법무실', [action('대체데이터 검토의견 최종 작성', '법무1', '07-25', '진행중')])]);
  const out = diffBoards(prev, cur);
  assert.notEqual(out.tags[key(0, '법무실', 'action', 0)], 'new', '퍼지 매칭돼야 하므로 new가 아니어야 한다');
});

test('퍼지 매칭: 부서가 바뀌어도(개명/이동) 전체 폴백으로 매칭된다', () => {
  const prev = board([dept('법무실', [action('대체데이터 검토의견 작성', '법무1', '07-25', '진행중')])]);
  const cur = board([dept('리스크본부', [action('대체데이터 검토의견 작성', '법무1', '07-25', '진행중')])]);
  const out = diffBoards(prev, cur);
  assert.notEqual(out.tags[key(0, '리스크본부', 'action', 0)], 'new', '부서명이 바뀌어도 전체 폴백으로 매칭돼야 한다');
  assert.equal(out.tags[key(0, '리스크본부', 'action', 0)], 'same');
});

test('전혀 다른 문구는 매칭되지 않고 new로 남는다', () => {
  const prev = board([dept('CB본부', [action('모델 재학습', 'CB1', '07-30', '진행중')])]);
  const cur = board([dept('CB본부', [action('예산 편성 검토', 'CB2', '08-05', '')])]);
  const out = diffBoards(prev, cur);
  assert.equal(out.tags[key(0, 'CB본부', 'action', 0)], 'new');
});

// ---------------------------------------------------------------------------
// 8. 불변성 — 입력 board를 변형하지 않는다
// ---------------------------------------------------------------------------

test('불변: diffBoards는 prevBoard/curBoard를 변형하지 않는다', () => {
  const prev = board([dept('CB본부', [action('모델 재학습', 'CB1', '07-30', '진행중')])]);
  const cur = board([dept('CB본부', [
    action('모델 재학습', 'CB1', '07-30', '확정'),
    action('신규 업무', 'CB3', '09-01', '')
  ])]);
  const prevSnap = snapshot(prev);
  const curSnap = snapshot(cur);
  diffBoards(prev, cur);
  assert.equal(snapshot(prev), prevSnap);
  assert.equal(snapshot(cur), curSnap);
});

// ---------------------------------------------------------------------------
// 9. 예외 없음 — null/이상 입력은 빈 diff
// ---------------------------------------------------------------------------

test('null/undefined 입력은 예외 없이 빈 tags·done을 돌려준다', () => {
  assert.deepEqual(diffBoards(null, null), { tags: {}, done: [] });
  assert.deepEqual(diffBoards(undefined, undefined), { tags: {}, done: [] });
  assert.deepEqual(diffBoards(null, undefined), { tags: {}, done: [] });
});

test('기형 board(문자열/숫자/빈 객체/깨진 by_department)도 예외 없이 처리한다', () => {
  assert.deepEqual(diffBoards('garbage', 42), { tags: {}, done: [] });
  assert.deepEqual(diffBoards({}, {}), { tags: {}, done: [] });
  assert.deepEqual(diffBoards({ by_department: 'not-an-array' }, { by_department: null }), { tags: {}, done: [] });
  const weird = { by_department: [null, { dept: 'X', action_items: [null, {}], decisions_needed: 'bad' }] };
  assert.doesNotThrow(() => diffBoards(weird, weird));
});

// ---------------------------------------------------------------------------
// 10. documents(문서)도 매칭 대상 — 설계 §2: action_items+documents+decisions
// ---------------------------------------------------------------------------

test('문서: prev에 없는 cur 문서는 new 태그(kind=doc)', () => {
  const prev = board([dept('CB본부', [], [], [])]);
  const cur = board([dept('CB본부', [], [], [document('이사회 보고자료', '라일라', '07-18', '확정')])]);
  const out = diffBoards(prev, cur);
  assert.equal(out.tags[key(0, 'CB본부', 'doc', 0)], 'new');
});

test('문서: owner/due가 달라지면 changed', () => {
  const prev = board([dept('CB본부', [], [], [document('이사회 보고자료', '라일라', '07-18', '추정')])]);
  const cur = board([dept('CB본부', [], [], [document('이사회 보고자료', '김대리', '07-20', '추정')])]);
  const out = diffBoards(prev, cur);
  assert.equal(out.tags[key(0, 'CB본부', 'doc', 0)], 'changed');
});

test('문서: status가 확정으로 바뀌면 done + done[]에 confirmed로 기록(kind=doc)', () => {
  const prev = board([dept('CB본부', [], [], [document('이사회 보고자료', '라일라', '07-18', '추정')])]);
  const cur = board([dept('CB본부', [], [], [document('이사회 보고자료', '라일라', '07-18', '확정')])]);
  const out = diffBoards(prev, cur);
  assert.equal(out.tags[key(0, 'CB본부', 'doc', 0)], 'done');
  assert.equal(out.done.length, 1);
  assert.equal(out.done[0].reason, 'confirmed');
  assert.equal(out.done[0].kind, 'doc');
});

// ---------------------------------------------------------------------------
// 11. 빈 값 ↔ '미정' 동치 — owner/due(및 decider) 비교는 board-derive.js isBlank와 동일 판정을 쓴다
// ---------------------------------------------------------------------------

test("동치: owner가 ''→'미정'으로 바뀐 것뿐이면(나머지 동일) changed가 아니라 same", () => {
  const prev = board([dept('CB본부', [action('모델 재학습', '', '07-30', '진행중')])]);
  const cur = board([dept('CB본부', [action('모델 재학습', '미정', '07-30', '진행중')])]);
  const out = diffBoards(prev, cur);
  assert.equal(out.tags[key(0, 'CB본부', 'action', 0)], 'same');
});

// ---------------------------------------------------------------------------
// 12. 특성화(characterization) — greedy 매칭은 안정적 이분매칭이 아니다(문서화된 현재 동작 고정)
//     의도된 동작이며 바꾸지 않는다. 이 테스트는 리팩터가 이 동작을 바꿀 때 반드시 인지하게 만든다.
// ---------------------------------------------------------------------------

test('[특성화] prev 항목 2개가 모두 cur 항목 1개와 매칭 가능해도 그리디 매칭이라 양쪽 다 dropped 처리되지 않는다', () => {
  const prev = board([dept('CB본부', [
    action('모델 재학습', 'CB1', '07-30', '진행중'),
    action('모델 재학습', 'CB2', '08-01', '진행중')
  ])]);
  const cur = board([dept('CB본부', [
    action('모델 재학습', 'CB1', '07-30', '진행중')
  ])]);
  const out = diffBoards(prev, cur);
  // 현재 실제 동작 고정: cur의 유일한 항목은 prev의 첫 항목(CB1)과 매칭돼 same.
  assert.deepEqual(out.tags, { [key(0, 'CB본부', 'action', 0)]: 'same' });
  // 두 prev 항목 모두 독립적으로(비배타적으로) cur의 그 하나와 매칭에 성공하므로
  // 이분매칭이었다면 dropped로 잡혔을 두 번째 prev 항목(CB2)도 dropped로 잡히지 않는다.
  assert.deepEqual(out.done, []);
});

// ---------------------------------------------------------------------------
// 12-1. changeDigest — 회차 간 주요 변경점 요약(메인 노출용)
// ---------------------------------------------------------------------------

test('changeDigest: 신규/변경/완료 건수와 total을 집계한다', () => {
  const prev = board([dept('CB본부', [
    action('모델 재학습', 'CB1', '07-30', '진행중'),   // 그대로 → same
    action('사라질 작업', 'CB2', '08-01', '진행중')     // cur에서 빠짐 → dropped(done)
  ])]);
  const cur = board([dept('CB본부', [
    action('모델 재학습', 'CB1', '08-15', '진행중'),    // due 변경 → changed
    action('완전 새 작업', 'CB9', '08-20', '진행중')     // 신규 → new
  ])]);
  const digest = changeDigest(diffBoards(prev, cur), cur);
  assert.equal(digest.added, 1, '신규 1');
  assert.equal(digest.changed, 1, '변경 1');
  assert.equal(digest.done, 1, '완료(빠짐) 1');
  assert.equal(digest.total, 3);
});

test('changeDigest: items는 신규→변경→완료 순이고 각 항목에 tag/dept/text가 있다', () => {
  const prev = board([dept('법무실', [action('법률 검토', 'L1', '08-04', '진행중')])]);
  const cur = board([dept('법무실', [
    action('법률 검토', 'L1', '08-11', '진행중'),   // changed
    action('가이드라인 수립', 'L2', '', '진행중')     // new
  ])]);
  const digest = changeDigest(diffBoards(prev, cur), cur);
  assert.equal(digest.items[0].tag, 'new', '신규가 먼저');
  assert.equal(digest.items[0].dept, '법무실');
  assert.ok(digest.items[0].text.length > 0);
  assert.equal(digest.items[1].tag, 'changed');
});

test('changeDigest: items는 최대 6개로 자른다', () => {
  const acts = [];
  for (let i = 0; i < 10; i++) acts.push(action('신규작업 ' + i, 'X', '', '진행중'));
  const cur = board([dept('CB본부', acts)]);
  const digest = changeDigest(diffBoards(board([]), cur), cur);
  // 첫 회차(prev 비어있음) 대비지만 여기선 prev=빈 보드라 전부 new
  assert.ok(digest.items.length <= 6, 'items 6개 이하');
});

test('changeDigest: diff가 null이거나 기형이어도 예외 없이 0을 돌려준다', () => {
  assert.deepEqual(changeDigest(null, board([])), { added: 0, changed: 0, done: 0, total: 0, items: [] });
  assert.deepEqual(changeDigest({}, board([])), { added: 0, changed: 0, done: 0, total: 0, items: [] });
  assert.doesNotThrow(() => changeDigest({ tags: { 'x::action::0': 'new' } }, '문자열'));
});

// ---------------------------------------------------------------------------
// 12-2. 중복 부서명 — by_department에 같은 dept명이 두 번 나와도(모델이 실제로 이렇게
//       출력하는 경우가 관찰됨) 각 항목이 독립적으로 태그돼야 한다(key 충돌 금지)
// ---------------------------------------------------------------------------

test('중복 부서명: 같은 dept명이 by_department에 두 번 있어도 각 항목이 독립적으로 태그된다(key 충돌 없음)', () => {
  const prev = board([
    dept('ICT본부', [action('시스템 점검', 'P1', '07-30', '진행중')]),
  ]);
  const cur = board([
    dept('ICT본부', [action('시스템 점검', 'P1', '07-30', '진행중')]),        // deptIdx 0: same
    dept('ICT본부', [action('완전 새로운 작업', 'P9', '08-20', '')]),          // deptIdx 1: new
  ]);
  const out = diffBoards(prev, cur);
  assert.equal(out.tags[key(0, 'ICT본부', 'action', 0)], 'same', '첫 번째 ICT본부 항목은 same이어야 한다');
  assert.equal(out.tags[key(1, 'ICT본부', 'action', 0)], 'new', '두 번째 ICT본부(다른 deptIdx) 항목은 new여야 한다 — deptIdx가 없으면 같은 key로 충돌해 이 값이 덮어써진다');
});

// ---------------------------------------------------------------------------
// 13. A·B 바이트 동일
// ---------------------------------------------------------------------------

test('A·B의 board-diff.js는 바이트 단위로 동일해야 한다 (복사 누락 방지)', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', 'A_웹페이지', '앱', 'board-diff.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'B_직접', '앱', 'board-diff.js'), 'utf8');
  assert.equal(a, b, 'A와 B의 board-diff.js가 다릅니다 — 한쪽만 고쳤습니다');
});
