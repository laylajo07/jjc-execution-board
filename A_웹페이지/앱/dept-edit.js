/* 조정치 · 부서 편집 — 실행보드에 적용하는 6종 편집(이름변경/이동/숨김/삭제/병합/추가) + 표시용 헬퍼 1종.
   순수(DOM·localStorage 접근 없음): 입력 board와 그 중첩 배열·객체를 변형하지 않고 새 board를 반환한다.
   file:// 더블클릭 지원을 위해 클래식 스크립트다. A·B 바이트 동일. */
(function (root) {
  'use strict';

  // 얕은 병합. Object.assign 폴리필 없이 file:// 더블클릭(구형 브라우저 포함)을 지원하려 직접 구현.
  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  }

  function isBoard(board) {
    return !!board && typeof board === 'object' && Array.isArray(board.by_department);
  }

  function isValidIdx(idx, len) {
    return typeof idx === 'number' && idx === Math.floor(idx) && idx >= 0 && idx < len;
  }

  function seqOf(board) {
    return Array.isArray(board.sequence) ? board.sequence : [];
  }

  // board의 얕은 사본을 만들고 by_department·sequence 두 배열만 교체한다.
  // meeting·headline·gaps 등 나머지 필드는 그대로 보존된다.
  function cloneBoard(board, byDepartment, sequence) {
    var out = assign({}, board);
    out.by_department = byDepartment;
    out.sequence = sequence;
    return out;
  }

  // dept 문자열 → 세그먼트 배열. '/' 로 나누고 각 조각을 trim, 빈 조각은 버린다.
  function splitDept(deptStr) {
    return String(deptStr == null ? '' : deptStr).split('/')
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s; });
  }

  // 부서 이름을 비교/조회 키로 쓸 때는 항상 trim한다.
  // splitDept가 세그먼트를 trim해서 만들기 때문에, 부서 자신의 dept를 raw로 키에 쓰면
  // (예: 'CB본부 '처럼 끝공백이 섞인 원본 데이터) sequence 세그먼트와 어긋나 매칭에 실패한다.
  function deptKey(dept) {
    return String(dept == null ? '' : dept).trim();
  }

  // 세그먼트 배열 → dept 문자열. 구분자는 '/'(공백 없음), 순서를 지키며 중복 제거.
  function joinDept(segments) {
    var seen = Object.create(null), out = [], i, s;
    for (i = 0; i < segments.length; i++) {
      s = segments[i];
      if (!seen[s]) { seen[s] = true; out.push(s); }
    }
    return out.join('/');
  }

  // sequence 전체에서 oldName 세그먼트를 newName으로 치환(중복 제거 후 재결합).
  // 어느 세그먼트도 oldName과 일치하지 않는 엔트리는 원본 참조 그대로 반환한다(추측 금지).
  // renameDept(이름 자체 변경)와 mergeDepts(from→to로 흡수) 둘 다 이 규칙을 그대로 쓴다.
  function renameSegmentsInSequence(seq, oldName, newName) {
    return seq.map(function (entry) {
      var segs = splitDept(entry && entry.dept);
      if (segs.indexOf(oldName) === -1) return entry;
      var newSegs = segs.map(function (s) { return s === oldName ? newName : s; });
      return assign({}, entry, { dept: joinDept(newSegs) });
    });
  }

  // sequence 전체에서 namesToRemove에 속한 세그먼트를 제거한다.
  //   - 남은 세그먼트가 있으면: 엔트리 유지, dept만 축소(공동 소유 작업을 통째로 지우지 않는다).
  //   - 세그먼트가 0개가 되면: 엔트리 제거.
  // 그다음 제거된 엔트리들의 id·task를 모아 남은 엔트리의 blocked_by에서 유령 참조를 정리한다
  // (blocked_by는 id 모드면 id, fuzzy 모드면 task 문자열이라 둘 다 모은다).
  // blocked_by_external은 외부 조직 참조라 건드리지 않는다.
  // deleteDept와 visibleBoard가 공유하는 내부 헬퍼.
  function removeDeptsFromSequence(seq, namesToRemove) {
    var removeSet = Object.create(null);
    namesToRemove.forEach(function (n) { removeSet[n] = true; });

    var kept = [];
    var removedIds = Object.create(null);
    var removedTasks = Object.create(null);
    var anyRemoved = false;

    seq.forEach(function (entry) {
      var origSegs = splitDept(entry && entry.dept);
      var hasRemoved = origSegs.some(function (s) { return removeSet[s]; });
      if (!hasRemoved) { kept.push(entry); return; }

      var remaining = origSegs.filter(function (s) { return !removeSet[s]; });
      if (remaining.length === 0) {
        anyRemoved = true;
        if (entry && entry.id != null) removedIds[String(entry.id)] = true;
        if (entry && entry.task != null) removedTasks[String(entry.task)] = true;
        return; // 엔트리 자체를 버린다
      }
      kept.push(assign({}, entry, { dept: joinDept(remaining) }));
    });

    if (!anyRemoved) return kept;

    return kept.map(function (entry) {
      var bb = Array.isArray(entry.blocked_by) ? entry.blocked_by : [];
      var filtered = bb.filter(function (b) {
        var s = String(b);
        return !removedIds[s] && !removedTasks[s];
      });
      if (filtered.length === bb.length) return entry;
      return assign({}, entry, { blocked_by: filtered });
    });
  }

  // ---- 6종 편집 + 헬퍼 1종 ------------------------------------------------

  function renameDept(board, idx, name) {
    if (!isBoard(board)) return board;
    var depts = board.by_department;
    if (!isValidIdx(idx, depts.length)) return board;
    var trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed || trimmed.indexOf('/') !== -1) return board; // '/'는 세그먼트 구분자라 이름에 못 쓴다

    var old = depts[idx].dept;
    if (trimmed === old) return board;
    var dup = depts.some(function (d, i) { return i !== idx && d && deptKey(d.dept) === trimmed; });
    if (dup) return board;

    var newDepts = depts.slice();
    newDepts[idx] = assign({}, depts[idx], { dept: trimmed });
    var newSeq = renameSegmentsInSequence(seqOf(board), deptKey(old), trimmed);
    return cloneBoard(board, newDepts, newSeq);
  }

  function moveDept(board, idx, dir) {
    if (!isBoard(board)) return board;
    if (dir !== 1 && dir !== -1) return board;
    var depts = board.by_department;
    if (!isValidIdx(idx, depts.length)) return board;
    var otherIdx = idx + dir;
    if (!isValidIdx(otherIdx, depts.length)) return board;

    var newDepts = depts.slice();
    var tmp = newDepts[idx];
    newDepts[idx] = newDepts[otherIdx];
    newDepts[otherIdx] = tmp;
    return cloneBoard(board, newDepts, seqOf(board)); // sequence는 표시 순서일 뿐 — 안 건드린다
  }

  function setHideDept(board, idx, hidden) {
    if (!isBoard(board)) return board;
    var depts = board.by_department;
    if (!isValidIdx(idx, depts.length)) return board;

    var newDepts = depts.slice();
    newDepts[idx] = assign({}, depts[idx], { _hidden: !!hidden });
    return cloneBoard(board, newDepts, seqOf(board)); // 숨김은 표시 상태 — sequence는 안 건드린다
  }

  function deleteDept(board, idx) {
    if (!isBoard(board)) return board;
    var depts = board.by_department;
    if (!isValidIdx(idx, depts.length)) return board;

    var name = deptKey(depts[idx].dept);
    var newDepts = depts.slice(0, idx).concat(depts.slice(idx + 1));
    var newSeq = removeDeptsFromSequence(seqOf(board), [name]);
    return cloneBoard(board, newDepts, newSeq);
  }

  function mergeDepts(board, fromIdx, toIdx) {
    if (!isBoard(board)) return board;
    var depts = board.by_department;
    if (!isValidIdx(fromIdx, depts.length) || !isValidIdx(toIdx, depts.length)) return board;
    if (fromIdx === toIdx) return board;

    var from = depts[fromIdx], to = depts[toIdx];
    var mergedTo = assign({}, to, {
      action_items: (to.action_items || []).concat(from.action_items || []),
      documents: (to.documents || []).concat(from.documents || []),
      decisions_needed: (to.decisions_needed || []).concat(from.decisions_needed || [])
    }); // to._hidden·to._rd는 손대지 않아 그대로 유지된다

    var newDepts = depts
      .map(function (d, i) { return i === toIdx ? mergedTo : d; })
      .filter(function (d, i) { return i !== fromIdx; });

    var newSeq = renameSegmentsInSequence(seqOf(board), deptKey(from.dept), deptKey(to.dept));
    return cloneBoard(board, newDepts, newSeq); // 엔트리는 지우지 않는다 — 작업은 살아있고 담당만 바뀐다
  }

  function addDept(board, name) {
    if (!isBoard(board)) return board;
    var trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed || trimmed.indexOf('/') !== -1) return board; // '/'는 세그먼트 구분자라 이름에 못 쓴다

    var depts = board.by_department;
    var dup = depts.some(function (d) { return d && deptKey(d.dept) === trimmed; });
    if (dup) return board;

    var newDepts = depts.concat([{
      dept: trimmed, action_items: [], documents: [], decisions_needed: [], _rd: []
    }]);
    return cloneBoard(board, newDepts, seqOf(board)); // sequence는 안 건드린다
  }

  // 헬퍼(설계 2-1엔 없는 7번째 함수): 숨긴 부서를 실제로 제외한 board를 만든다.
  // 렌더·MD·JSON 출력이 이 하나를 공유해 "숨김 → DAG 노드도 제외" 규칙이 세 곳에서 어긋나지 않게 한다.
  // 원본 board는 그대로 둔다(숨김은 되돌릴 수 있어야 하므로) — 항상 새 board를 반환.
  function visibleBoard(board) {
    if (!isBoard(board)) return board;
    var depts = board.by_department;
    var hiddenNames = depts.filter(function (d) { return d && d._hidden; })
      .map(function (d) { return deptKey(d.dept); });
    var newDepts = depts.filter(function (d) { return !(d && d._hidden); });
    var seq = seqOf(board);
    var newSeq = hiddenNames.length ? removeDeptsFromSequence(seq, hiddenNames) : seq;
    return cloneBoard(board, newDepts, newSeq);
  }

  var api = {
    renameDept: renameDept,
    moveDept: moveDept,
    setHideDept: setHideDept,
    deleteDept: deleteDept,
    mergeDepts: mergeDepts,
    addDept: addDept,
    visibleBoard: visibleBoard
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DeptEdit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
