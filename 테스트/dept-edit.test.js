const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  renameDept, moveDept, setHideDept, deleteDept, mergeDepts, addDept, setItemOwner, visibleBoard
} = require('../B_직접/앱/dept-edit.js');
const { buildGraph } = require('../B_직접/앱/graph.js');

// 브리프 fixture 값(테스트/fixtures/샘플01_신스키마.json)에 등장하는 실제 복수부서
// 표기(경영본부/ICT본부, CB본부/법무실)를 그대로 써서 세그먼트 처리를 검증한다.
function makeBoard() {
  return {
    meeting: { title: '테스트 회의', date: '2026-07-20' },
    by_department: [
      { dept: '법무실', action_items: [{ what: '검토의견 작성', owner: '법무1', due: '', status: '', basis: '' }], documents: [], decisions_needed: [], _rd: [] },
      { dept: 'CB본부', action_items: [{ what: '모델 재학습', owner: 'CB1', due: '', status: '', basis: '' }], documents: [{ doc: '단가표', owner: 'CB1', due: '', purpose: '', status: '' }], decisions_needed: [], _rd: [] },
      { dept: '경영본부', action_items: [], documents: [], decisions_needed: [{ topic: '가격정책', decider: '경영1', due: '', precondition: '', status: '' }], _rd: [] },
      { dept: 'ICT본부', action_items: [{ what: 'API 최적화', owner: 'ICT1', due: '', status: '', basis: '' }], documents: [], decisions_needed: [], _rd: [] }
    ],
    sequence: [
      { id: 'T1', task: '대체데이터 검토의견 작성', dept: '법무실', blocked_by: [], blocked_by_external: [] },
      { id: 'T2', task: 'v2 모델 재학습', dept: 'CB본부', blocked_by: [], blocked_by_external: [] },
      { id: 'T3', task: '가격 단가표 초안 작성', dept: '경영본부', blocked_by: [], blocked_by_external: [] },
      { id: 'T6', task: 'PoC 데모환경 준비', dept: '경영본부/ICT본부', blocked_by: ['T2', 'T3'], blocked_by_external: [] },
      { id: 'T10', task: '대체데이터 모델 반영 여부 결정', dept: 'CB본부/법무실', blocked_by: ['T1'], blocked_by_external: ['외부 법률자문'] }
    ],
    gaps: ['미정 목표치 있음']
  };
}

function snapshot(board) { return JSON.stringify(board); }

// ---------------------------------------------------------------------------
// 1. 6종 정상 동작
// ---------------------------------------------------------------------------

test('renameDept: 부서명을 바꾸고 sequence의 단일부서 엔트리도 따라간다', () => {
  const board = makeBoard();
  const out = renameDept(board, 1, '리스크본부');
  assert.equal(out.by_department[1].dept, '리스크본부');
  assert.equal(out.sequence[1].dept, '리스크본부'); // T2
});

test('moveDept: 인접한 두 부서의 표시 순서를 맞바꾼다', () => {
  const board = makeBoard();
  const out = moveDept(board, 0, 1);
  assert.equal(out.by_department[0].dept, 'CB본부');
  assert.equal(out.by_department[1].dept, '법무실');
});

test('setHideDept: 지정한 부서에 _hidden 플래그를 세운다', () => {
  const board = makeBoard();
  const out = setHideDept(board, 2, true);
  assert.equal(out.by_department[2]._hidden, true);
  const back = setHideDept(out, 2, false);
  assert.equal(back.by_department[2]._hidden, false);
});

test('deleteDept: 단일부서 엔트리를 참조하는 부서를 지우면 by_department에서 사라진다', () => {
  const board = makeBoard();
  const out = deleteDept(board, 2); // 경영본부
  assert.equal(out.by_department.length, 3);
  assert.ok(!out.by_department.some(d => d.dept === '경영본부'));
});

test('mergeDepts: to에 action_items/documents/decisions_needed가 순서대로 이어붙고, to._rd는 보존되며, _hidden은 한쪽이라도 visible이면 visible이 된다', () => {
  const board = makeBoard();
  // to(CB본부)·from(ICT본부) 둘 다 세 배열 전부에 값을 채워야 "이어붙임"이 실제로 검증된다
  // (원래 fixture는 documents/decisions_needed 쪽이 비어 있어 뮤턴트가 안 잡혔다).
  board.by_department[1].decisions_needed = [{ topic: '단가승인', decider: 'CB1', due: '', precondition: '', status: '' }];
  board.by_department[1]._hidden = true;
  board.by_department[1]._rd = ['to-rd'];
  board.by_department[3].documents = [{ doc: 'API 명세', owner: 'ICT1', due: '', purpose: '', status: '' }];
  board.by_department[3].decisions_needed = [{ topic: '배포일정', decider: 'ICT1', due: '', precondition: '', status: '' }];
  board.by_department[3]._hidden = false;
  board.by_department[3]._rd = ['from-rd'];

  const out = mergeDepts(board, 3, 1); // ICT본부(visible) → CB본부(hidden)
  const to = out.by_department.find(d => d.dept === 'CB본부');

  assert.deepEqual(to.action_items.map(a => a.what), ['모델 재학습', 'API 최적화']);
  assert.deepEqual(to.documents.map(d => d.doc), ['단가표', 'API 명세']);
  assert.deepEqual(to.decisions_needed.map(d => d.topic), ['단가승인', '배포일정']);
  // to는 숨김이었지만 from은 보이는(실제 항목을 가진) 부서였으므로, 병합 결과는 visible이어야
  // 한다 — 그렇지 않으면 from의 항목들이 visibleBoard()에서 통째로 사라지는 자체 감사 버그가 된다.
  assert.equal(to._hidden, false, '숨김 to + 보이는 from을 병합하면 결과는 visible이어야 한다(데이터 소실 방지)');
  assert.deepEqual(to._rd, ['to-rd'], 'to._rd는 from._rd로 덮이면 안 된다');
  assert.equal(out.by_department.length, 3);
});

test('mergeDepts: 둘 다 숨김이었으면 병합 결과도 숨김을 유지한다', () => {
  const board = makeBoard();
  board.by_department[1]._hidden = true; // to
  board.by_department[3]._hidden = true; // from
  const out = mergeDepts(board, 3, 1);
  const to = out.by_department.find(d => d.dept === 'CB본부');
  assert.equal(to._hidden, true, '둘 다 숨김이면 합쳐도 숨김 그대로여야 한다');
});

test('mergeDepts: to가 visible이고 from이 숨김이면 결과는 그대로 visible(회귀 없음)', () => {
  const board = makeBoard();
  board.by_department[1]._hidden = false; // to
  board.by_department[3]._hidden = true;  // from
  const out = mergeDepts(board, 3, 1);
  const to = out.by_department.find(d => d.dept === 'CB본부');
  assert.equal(to._hidden, false);
});

test('[자체감사] mergeDepts: 보이는 부서를 숨김 부서로 병합해도 항목이 visibleBoard()에서 사라지지 않는다', () => {
  // 실제 버그 재현: A본부(visible, 실제 항목 있음) → B본부(hidden)로 병합.
  // 이전 구현은 to._hidden을 무조건 보존해 병합 결과가 계속 숨겨져, A본부의 항목이
  // visibleBoard() 결과에서 통째로 사라졌다(사용자에게 아무 경고도 없이).
  const board = {
    by_department: [
      { dept: 'A본부', action_items: [{ what: '중요 작업', owner: '', due: '', status: '확정' }], documents: [], decisions_needed: [], _rd: [] },
      { dept: 'B본부', action_items: [], documents: [], decisions_needed: [], _hidden: true, _rd: [] }
    ],
    sequence: []
  };
  const merged = mergeDepts(board, 0, 1); // A본부 → B본부
  const vis = visibleBoard(merged);
  assert.equal(vis.by_department.length, 1, '병합된 부서가 visibleBoard에서 사라지면 안 된다');
  assert.deepEqual(vis.by_department[0].action_items.map(a => a.what), ['중요 작업']);
});

test('addDept: 끝에 빈 부서를 추가한다', () => {
  const board = makeBoard();
  const out = addDept(board, '신설본부');
  assert.equal(out.by_department.length, 5);
  const added = out.by_department[4];
  assert.equal(added.dept, '신설본부');
  assert.deepEqual(added.action_items, []);
  assert.deepEqual(added.documents, []);
  assert.deepEqual(added.decisions_needed, []);
  assert.deepEqual(added._rd, []);
});

test('visibleBoard: 헬퍼 — 숨김 부서를 by_department에서 제외한다', () => {
  const board = makeBoard();
  const hidden = setHideDept(board, 2, true); // 경영본부 숨김
  const out = visibleBoard(hidden);
  assert.ok(!out.by_department.some(d => d.dept === '경영본부'));
  assert.equal(out.by_department.length, 3);
});

// ---------------------------------------------------------------------------
// 2. 불변성 — 모든 함수 호출 후 입력 board가 안 변했는지
// ---------------------------------------------------------------------------

test('불변성: 6종 함수 모두 입력 board를 변형하지 않는다', () => {
  const calls = [
    b => renameDept(b, 1, '리스크본부'),
    b => moveDept(b, 0, 1),
    b => setHideDept(b, 2, true),
    b => deleteDept(b, 2),
    b => mergeDepts(b, 3, 1),
    b => addDept(b, '신설본부'),
    b => visibleBoard(setHideDept(b, 0, true))
  ];
  calls.forEach((fn, i) => {
    const board = makeBoard();
    const before = snapshot(board);
    const deptCount = board.by_department.length;
    const seqLen = board.sequence.length;
    const deptNames = board.by_department.map(d => d.dept);
    fn(board);
    assert.equal(snapshot(board), before, `호출 #${i}가 board를 변형했다`);
    assert.equal(board.by_department.length, deptCount);
    assert.equal(board.sequence.length, seqLen);
    assert.deepEqual(board.by_department.map(d => d.dept), deptNames);
  });
});

test('불변성: 수정된 by_department 원소는 사본이고, 안 바뀐 원소는 그대로다', () => {
  const board = makeBoard();
  const out = setHideDept(board, 2, true);
  assert.notEqual(out.by_department[2], board.by_department[2], '수정된 원소는 사본이어야 한다');
  assert.equal(out.by_department[0], board.by_department[0], '안 바뀐 원소는 참조를 공유해도 된다');
  assert.equal(out.by_department[1], board.by_department[1]);
});

// ---------------------------------------------------------------------------
// 3. 복수 부서 세그먼트 — 이 태스크의 핵심 위험
// ---------------------------------------------------------------------------

test('세그먼트: 이름 변경이 복합 dept(경영본부/ICT본부) 안의 한 세그먼트만 바꾼다', () => {
  const board = makeBoard();
  const out = renameDept(board, 2, '전략본부'); // 경영본부 → 전략본부
  const t6 = out.sequence.find(s => s.id === 'T6');
  assert.equal(t6.dept, '전략본부/ICT본부');
});

test('세그먼트: 삭제가 공동소유 엔트리(CB본부/법무실)를 지우지 않고 세그먼트만 줄인다', () => {
  const board = makeBoard();
  const out = deleteDept(board, 0); // 법무실 삭제
  const t10 = out.sequence.find(s => s.id === 'T10');
  assert.ok(t10, 'T10 엔트리는 살아 있어야 한다');
  assert.equal(t10.dept, 'CB본부');
  // T1(법무실 단독)은 통째로 사라진다
  assert.ok(!out.sequence.some(s => s.id === 'T1'));
});

test('세그먼트: 삭제로 세그먼트가 0개가 되면 엔트리가 사라진다', () => {
  const board = makeBoard();
  let out = deleteDept(board, 0); // 법무실 삭제 → T1 제거, T10 dept: CB본부
  out = deleteDept(out, out.by_department.findIndex(d => d.dept === 'CB본부')); // CB본부 삭제
  assert.ok(!out.sequence.some(s => s.id === 'T10'), 'T10은 세그먼트가 0개가 되어 사라져야 한다');
  assert.ok(!out.sequence.some(s => s.id === 'T2'), 'T2(CB본부 단독)도 사라져야 한다');
});

test('세그먼트: 병합이 A/B → A 로 접히고 A/A 가 안 생긴다', () => {
  const board = makeBoard();
  const out = mergeDepts(board, 3, 2); // ICT본부 → 경영본부로 병합
  const t6 = out.sequence.find(s => s.id === 'T6');
  assert.equal(t6.dept, '경영본부');
  assert.ok(!t6.dept.includes('/'), 'A/A 형태가 남으면 안 된다');
});

test('세그먼트: 구분자 앞뒤 공백이 있는 복합 dept도 세그먼트 단위로 trim되어 매칭된다', () => {
  const board = makeBoard();
  board.sequence.push({ id: 'T11', task: '공백 포함 복합부서 작업', dept: 'CB본부 / 법무실', blocked_by: [], blocked_by_external: [] });
  const out = renameDept(board, 1, '리스크본부'); // CB본부 → 리스크본부
  const t11 = out.sequence.find(s => s.id === 'T11');
  assert.equal(t11.dept, '리스크본부/법무실', '세그먼트가 trim된 뒤 일치해야 치환되고, 재결합은 공백 없는 / 여야 한다');
});

test('세그먼트: 연속된 //로 생긴 빈 세그먼트는 버려진다', () => {
  const board = makeBoard();
  board.sequence.push({ id: 'T12', task: '이중 슬래시 표기', dept: 'CB본부//법무실', blocked_by: [], blocked_by_external: [] });
  const out = deleteDept(board, 1); // CB본부 삭제
  const t12 = out.sequence.find(s => s.id === 'T12');
  assert.ok(t12, 'T12은 법무실 세그먼트로 살아남아야 한다');
  assert.equal(t12.dept, '법무실', '빈 세그먼트 없이 법무실만 남아야 한다');
});

// ---------------------------------------------------------------------------
// 4. 끊어진 참조 정리 — Graph.buildGraph로 검증(제일 중요한 단언)
// ---------------------------------------------------------------------------

test('끊어진 참조 정리: 부서 삭제로 사라진 선행 id가 buildGraph에서 유령 미해결로 안 남는다', () => {
  const board = makeBoard();
  // 경영본부 삭제 → T3(경영본부 단독) 제거됨. T6.blocked_by는 ['T2','T3']였는데
  // T3가 사라졌으니 'T3' 참조가 정리되어야 한다. T6 자신은 경영본부/ICT본부라 ICT본부로 살아남는다.
  const out = deleteDept(board, 2); // idx 2 = 경영본부
  const t6 = out.sequence.find(s => s.id === 'T6');
  assert.ok(t6, 'T6은 ICT본부 세그먼트로 살아남아야 한다');
  assert.equal(t6.dept, 'ICT본부');
  assert.ok(!t6.blocked_by.includes('T3'), '사라진 T3 참조가 정리되어야 한다');
  assert.ok(t6.blocked_by.includes('T2'), '살아있는 T2 참조는 유지되어야 한다');

  const g = buildGraph(out.sequence);
  assert.equal(g.stats.edgeTotal, g.stats.edgeResolved, '유령 선행이 남아 미해결 경고가 뜨면 안 된다');
});

test('끊어진 참조 정리: blocked_by_external은 건드리지 않는다', () => {
  const board = makeBoard();
  const out = deleteDept(board, 0); // 법무실 삭제 (T10에 영향)
  const t10 = out.sequence.find(s => s.id === 'T10');
  assert.deepEqual(t10.blocked_by_external, ['외부 법률자문']);
});

test('끊어진 참조 정리: visibleBoard도 숨긴 부서로 사라진 엔트리의 참조를 정리한다', () => {
  const board = makeBoard();
  const hidden = setHideDept(board, 2, true); // 경영본부 숨김
  const out = visibleBoard(hidden);
  const t6 = out.sequence.find(s => s.id === 'T6');
  assert.equal(t6.dept, 'ICT본부');
  assert.ok(!t6.blocked_by.includes('T3'));
  const g = buildGraph(out.sequence);
  assert.equal(g.stats.edgeTotal, g.stats.edgeResolved);
});

test('끊어진 참조 정리: fuzzy 모드(blocked_by가 id가 아니라 task 문자열)에서도 정리된다', () => {
  const board = {
    by_department: [
      { dept: '법무실', action_items: [], documents: [], decisions_needed: [], _rd: [] },
      { dept: 'CB본부', action_items: [], documents: [], decisions_needed: [], _rd: [] }
    ],
    sequence: [
      { id: null, task: '가격 단가표 초안 작성', dept: 'CB본부', blocked_by: [], blocked_by_external: [] },
      { id: null, task: 'PoC 데모환경 준비', dept: '법무실', blocked_by: ['가격 단가표 초안 작성'], blocked_by_external: [] }
    ]
  };
  const out = deleteDept(board, 1); // CB본부 삭제 → task 문자열 기반 엔트리가 사라짐
  const remaining = out.sequence.find(s => s.task === 'PoC 데모환경 준비');
  assert.ok(remaining, '법무실 엔트리는 남아야 한다');
  assert.ok(!remaining.blocked_by.includes('가격 단가표 초안 작성'), 'fuzzy 모드 task 문자열 참조도 정리되어야 한다');
});

// ---------------------------------------------------------------------------
// 5. 불변식 — 동일 이름 부서 중복 방지
// ---------------------------------------------------------------------------

test('불변식: addDept는 이미 있는 이름이면 변경 없이 반환한다', () => {
  const board = makeBoard();
  const out = addDept(board, 'CB본부');
  assert.equal(out, board);
  assert.equal(out.by_department.length, 4);
});

test('불변식: addDept는 trim 후 비교한다 (공백만 다른 중복도 막는다)', () => {
  const board = makeBoard();
  const out = addDept(board, '  CB본부  ');
  assert.equal(out, board);
});

test('불변식: renameDept가 다른 인덱스의 기존 부서명과 같으면 변경 없이 반환한다', () => {
  const board = makeBoard();
  const out = renameDept(board, 0, 'CB본부'); // 법무실 → CB본부(이미 idx1에 존재)
  assert.equal(out, board);
});

test('불변식: addDept는 이름에 /가 있으면 거부하고 원본을 그대로 반환한다', () => {
  const board = makeBoard();
  const out = addDept(board, 'A/B');
  assert.equal(out, board);
  assert.equal(out.by_department.length, 4);
});

test('불변식: renameDept는 이름에 /가 있으면 거부하고 원본을 그대로 반환한다', () => {
  const board = makeBoard();
  const out = renameDept(board, 0, 'A/B');
  assert.equal(out, board);
});

// ---------------------------------------------------------------------------
// 5b. trim — 부서 자신의 dept가 끝공백을 포함해도 매칭 키가 어긋나지 않는다
// ---------------------------------------------------------------------------

function makeTrimBoard() {
  return {
    by_department: [
      { dept: 'CB본부 ', action_items: [], documents: [], decisions_needed: [], _rd: [] }, // 끝공백
      { dept: '법무실', action_items: [], documents: [], decisions_needed: [], _rd: [] }
    ],
    sequence: [
      { id: 'T1', task: '대체데이터 모델 반영 여부 결정', dept: 'CB본부/법무실', blocked_by: [], blocked_by_external: [] }
    ]
  };
}

test('trim: 부서명 끝공백이 있어도 delete가 sequence 세그먼트를 제대로 찾아 지운다', () => {
  const board = makeTrimBoard();
  const out = deleteDept(board, 0); // 'CB본부 ' 삭제 (끝공백)
  const t1 = out.sequence.find(s => s.id === 'T1');
  assert.ok(t1, 'T1은 법무실 세그먼트로 살아남아야 한다');
  assert.equal(t1.dept, '법무실', 'CB본부 세그먼트가 trim 비교로 제거되어야 한다(고아 참조 금지)');
});

test('trim: 부서명 끝공백이 있어도 setHideDept+visibleBoard가 DAG에서 제외한다', () => {
  const board = makeTrimBoard();
  const hidden = setHideDept(board, 0, true); // 'CB본부 ' 숨김
  const out = visibleBoard(hidden);
  const t1 = out.sequence.find(s => s.id === 'T1');
  assert.ok(t1, 'T1은 법무실 세그먼트로 살아남아야 한다');
  assert.equal(t1.dept, '법무실', '숨긴 CB본부(끝공백)가 trim 비교로 제외되어야 한다');
});

test('trim: 끝공백만 다른 이름은 addDept 중복 판정에 걸린다', () => {
  const board = makeTrimBoard(); // by_department[0].dept === 'CB본부 '
  const out = addDept(board, 'CB본부'); // 공백 없는 같은 이름
  assert.equal(out, board, '트리밍하면 같은 이름이므로 추가되면 안 된다');
});

// ---------------------------------------------------------------------------
// 6. 엣지 케이스 — 전부 조용히 원본 반환(예외 없음)
// ---------------------------------------------------------------------------

test('엣지: idx가 범위 밖이면 모든 함수가 조용히 원본을 반환한다', () => {
  const board = makeBoard();
  assert.equal(renameDept(board, 99, '새이름'), board);
  assert.equal(renameDept(board, -1, '새이름'), board);
  assert.equal(moveDept(board, 99, 1), board);
  assert.equal(setHideDept(board, 99, true), board);
  assert.equal(deleteDept(board, 99), board);
  assert.equal(mergeDepts(board, 99, 0), board);
  assert.equal(mergeDepts(board, 0, 99), board);
});

test('엣지: board가 null/undefined면 모든 함수가 조용히 원본을 반환한다', () => {
  assert.equal(renameDept(null, 0, '새이름'), null);
  assert.equal(moveDept(undefined, 0, 1), undefined);
  assert.equal(setHideDept(null, 0, true), null);
  assert.equal(deleteDept(null, 0), null);
  assert.equal(mergeDepts(null, 0, 1), null);
  assert.equal(addDept(null, '새부서'), null);
  assert.equal(visibleBoard(null), null);
});

test('엣지: by_department가 배열이 아니면 조용히 원본을 반환한다', () => {
  const board = { by_department: 'oops', sequence: [] };
  assert.equal(renameDept(board, 0, '새이름'), board);
  assert.equal(addDept(board, '새부서'), board);
});

test('엣지: 빈 이름은 renameDept·addDept 모두 무시된다', () => {
  const board = makeBoard();
  assert.equal(renameDept(board, 0, ''), board);
  assert.equal(renameDept(board, 0, '   '), board);
  assert.equal(addDept(board, ''), board);
  assert.equal(addDept(board, '   '), board);
});

test('엣지: dir이 ±1이 아니면 moveDept는 조용히 원본을 반환한다', () => {
  const board = makeBoard();
  assert.equal(moveDept(board, 0, 0), board);
  assert.equal(moveDept(board, 0, 2), board);
  assert.equal(moveDept(board, 0, -2), board);
});

test('엣지: moveDept가 배열 경계를 넘어가면 조용히 원본을 반환한다', () => {
  const board = makeBoard();
  assert.equal(moveDept(board, 0, -1), board); // 맨 앞을 위로
  assert.equal(moveDept(board, 3, 1), board);  // 맨 뒤를 아래로
});

test('엣지: mergeDepts는 fromIdx===toIdx면 조용히 원본을 반환한다', () => {
  const board = makeBoard();
  assert.equal(mergeDepts(board, 1, 1), board);
});

// ---------------------------------------------------------------------------
// 7. setHideDept는 sequence를 안 바꾸고, visibleBoard가 그때 노드를 제외
// ---------------------------------------------------------------------------

test('setHideDept는 sequence를 그대로 유지(참조까지)하고, visibleBoard가 그 시점에 노드를 제외한다', () => {
  const board = makeBoard();
  const hidden = setHideDept(board, 2, true); // 경영본부 숨김
  assert.equal(hidden.sequence, board.sequence, 'setHideDept는 sequence 참조를 안 건드려야 한다');
  assert.ok(hidden.sequence.some(s => s.id === 'T6'), 'setHideDept 단계에서는 T6이 그대로 있어야 한다');

  const visible = visibleBoard(hidden);
  const t6 = visible.sequence.find(s => s.id === 'T6');
  assert.equal(t6.dept, 'ICT본부', 'visibleBoard 단계에서 비로소 숨긴 세그먼트가 빠진다');
});

test('moveDept·addDept도 sequence 참조를 그대로 유지한다', () => {
  const board = makeBoard();
  assert.equal(moveDept(board, 0, 1).sequence, board.sequence);
  assert.equal(addDept(board, '신설본부').sequence, board.sequence);
});

test('sequence: board에 sequence 키가 없으면 7종 함수 모두 배열을 반환한다(undefined 금지)', () => {
  const noSeqBoard = () => ({
    by_department: [
      { dept: '법무실', action_items: [], documents: [], decisions_needed: [], _rd: [] },
      { dept: 'CB본부', action_items: [], documents: [], decisions_needed: [], _rd: [] }
    ]
  });
  assert.ok(Array.isArray(renameDept(noSeqBoard(), 0, '새이름').sequence));
  assert.ok(Array.isArray(moveDept(noSeqBoard(), 0, 1).sequence));
  assert.ok(Array.isArray(setHideDept(noSeqBoard(), 0, true).sequence));
  assert.ok(Array.isArray(deleteDept(noSeqBoard(), 0).sequence));
  assert.ok(Array.isArray(mergeDepts(noSeqBoard(), 0, 1).sequence));
  assert.ok(Array.isArray(addDept(noSeqBoard(), '신설').sequence));
  assert.ok(Array.isArray(visibleBoard(noSeqBoard()).sequence));
});

// ---------------------------------------------------------------------------
// 반환 board는 나머지 필드(meeting·gaps 등)를 보존한다
// ---------------------------------------------------------------------------

test('반환 board는 meeting·gaps 등 다른 필드를 그대로 보존한다', () => {
  const board = makeBoard();
  const out = renameDept(board, 1, '리스크본부');
  assert.deepEqual(out.meeting, board.meeting);
  assert.deepEqual(out.gaps, board.gaps);
});

// ---------------------------------------------------------------------------
// 9. setItemOwner — 담당자/결정자 지정(지시사항 35~42)
// ---------------------------------------------------------------------------

test('setItemOwner: action 항목의 owner를 지정한다', () => {
  const board = makeBoard();
  const out = setItemOwner(board, 0, 'action', 0, '법무실 · 계약팀 · 홍길동');
  assert.equal(out.by_department[0].action_items[0].owner, '법무실 · 계약팀 · 홍길동');
  assert.equal(board.by_department[0].action_items[0].owner, '법무1', '원본은 안 바뀐다');
});

test('setItemOwner: doc 항목의 owner를 지정한다', () => {
  const board = makeBoard();
  const out = setItemOwner(board, 1, 'doc', 0, 'CB본부 · · 김본부');
  assert.equal(out.by_department[1].documents[0].owner, 'CB본부 · · 김본부');
});

test('setItemOwner: decision 항목은 decider 필드에 지정한다', () => {
  const board = makeBoard();
  const out = setItemOwner(board, 2, 'decision', 0, '경영본부');
  assert.equal(out.by_department[2].decisions_needed[0].decider, '경영본부');
});

test('setItemOwner: 팀만 지정하고 이름은 비워도 그대로 저장된다(지시 42)', () => {
  const board = makeBoard();
  const out = setItemOwner(board, 0, 'action', 0, '법무실 · 계약팀');
  assert.equal(out.by_department[0].action_items[0].owner, '법무실 · 계약팀');
});

test('setItemOwner: 앞뒤 공백은 trim된다', () => {
  const board = makeBoard();
  const out = setItemOwner(board, 0, 'action', 0, '  홍길동  ');
  assert.equal(out.by_department[0].action_items[0].owner, '홍길동');
});

test('setItemOwner: 값이 그대로면 원본 board를 그대로 반환한다', () => {
  const board = makeBoard();
  const out = setItemOwner(board, 0, 'action', 0, '법무1');
  assert.equal(out, board);
});

test('setItemOwner: kind가 잘못되면 조용히 원본을 반환한다', () => {
  const board = makeBoard();
  assert.equal(setItemOwner(board, 0, 'nope', 0, '이름'), board);
});

test('setItemOwner: deptIdx·itemIdx가 범위 밖이면 조용히 원본을 반환한다', () => {
  const board = makeBoard();
  assert.equal(setItemOwner(board, 99, 'action', 0, '이름'), board);
  assert.equal(setItemOwner(board, -1, 'action', 0, '이름'), board);
  assert.equal(setItemOwner(board, 0, 'action', 99, '이름'), board);
  assert.equal(setItemOwner(board, 0, 'action', -1, '이름'), board);
});

test('setItemOwner: board가 null/undefined면 조용히 원본을 반환한다', () => {
  assert.equal(setItemOwner(null, 0, 'action', 0, '이름'), null);
  assert.equal(setItemOwner(undefined, 0, 'action', 0, '이름'), undefined);
});

test('setItemOwner: sequence·다른 부서·다른 항목은 건드리지 않는다', () => {
  const board = makeBoard();
  const out = setItemOwner(board, 0, 'action', 0, '홍길동');
  assert.equal(out.sequence, board.sequence, 'sequence 참조는 그대로여야 한다(담당자 지정은 선후행에 영향 없음)');
  assert.equal(out.by_department[1], board.by_department[1], '건드리지 않은 부서는 참조를 공유해도 된다');
  assert.notEqual(out.by_department[0], board.by_department[0], '수정된 부서는 사본이어야 한다');
});

test('setItemOwner: 입력 board를 변형하지 않는다', () => {
  const board = makeBoard();
  const before = snapshot(board);
  setItemOwner(board, 0, 'action', 0, '홍길동');
  assert.equal(snapshot(board), before);
});

// ---------------------------------------------------------------------------
// 8. A·B 바이트 동일
// ---------------------------------------------------------------------------

test('A·B의 dept-edit.js는 바이트 단위로 동일해야 한다 (복사 누락 방지)', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', 'A_웹페이지', '앱', 'dept-edit.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'B_직접', '앱', 'dept-edit.js'), 'utf8');
  assert.equal(a, b, 'A와 B의 dept-edit.js가 다릅니다 — 한쪽만 고쳤습니다');
});
