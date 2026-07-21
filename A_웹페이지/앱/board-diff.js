/* 조정치 · 프로젝트 히스토리 diff — 회차(prev/cur) 두 보드를 비교해 신규/완료/변경을 태그한다.
   순수(DOM 접근 없음). graph.js 다음에 로드되어야 한다(containment 재사용).
   file:// 지원을 위해 클래식 스크립트. A·B 바이트 동일.

   diffBoards(prevBoard, curBoard) → { tags, done }

   반환 형태:
   - tags: { '<dept>::<kind>::<idx>': 'new'|'changed'|'done'|'same' }
       curBoard의 항목별 태그. key는 그 항목이 속한 부서명(dept) + 종류(kind) +
       그 부서·종류 배열 안에서의 0-based 순번(idx)으로 만든다(렌더러가 by_department를
       그대로 순회하며 조회할 수 있게 하기 위함 — by_department 배열 순서가 바뀌어도
       dept명이 안 바뀌면 key는 안정적이다).
       kind: 'action'(action_items) | 'decision'(decisions_needed)
   - done: [{ dept, kind, idx, text, owner, due, status, reason }]
       '완료'로 판정된 항목 목록. reason:
         'dropped'   — prev에는 있었는데 cur에 매칭되는 항목이 없음(idx는 prevBoard 쪽 배열 인덱스)
         'confirmed' — 매칭됐고 status가 이번 회차에 '확정'으로 새로 바뀜(idx는 curBoard 쪽 배열 인덱스)
       confirmed 항목은 tags에도 동일 key로 'done'이 이미 찍혀 있다(중복 조회 가능하게).

   태그 판정 우선순위(cur 항목 기준):
     1) prev에서 매칭되는 항목이 없다              → 'new'
     2) 매칭되고, status가 이번에 '확정'으로 바뀌었다 → 'done' (done[]에 reason:'confirmed' 추가)
        (이미 '확정'이었고 계속 '확정'이면 전이가 아니므로 여기 해당 안 됨 → 3으로)
     3) 매칭되고, owner/due/status 중 하나라도 다르다 → 'changed'
     4) 그 외(매칭되고 전부 동일)                    → 'same'
   prevBoard가 없으면(첫 회차, null/undefined) 비교 대상이 없으므로 cur 전부 'same'(스펙 §2 — 'new' 아님).

   매칭 규칙: 항목 텍스트(action_items의 what / decisions_needed의 topic)를 graph.js의
   containment(bigram 포함계수)로 비교한다. 같은 kind(action↔action, decision↔decision)끼리만
   비교하고, 우선 같은 dept 안에서 최댓값을 찾은 뒤 임계 0.6 미만이면 dept 무관 전체 풀로 폴백한다
   (부서 개명·이동 대응 — board-derive.js의 buildDetailMap과 같은 관용구). 매칭은 방향성 있는
   greedy 최댓값 매칭이며 안정적 이분매칭이 아니다(그래프 엔진 전반의 관용구를 따름).

   순수·불변·DOM 미접근. 입력이 없거나 기형이어도 예외를 던지지 않고 빈 diff({tags:{},done:[]})를
   돌려준다.
*/
(function (root) {
  'use strict';

  var G = (typeof module !== 'undefined' && module.exports) ? require('./graph.js') : root.Graph;

  var MATCH_THRESH = 0.6;

  function str(v) { return v == null ? '' : String(v); }

  // by_department → 평탄화된 항목 목록 [{dept, kind, idx, text, owner, due, status}]
  function flatten(board) {
    var depts = (board && Array.isArray(board.by_department)) ? board.by_department : [];
    var out = [];
    depts.forEach(function (d) {
      if (!d) return;
      var dept = str(d.dept);
      (Array.isArray(d.action_items) ? d.action_items : []).forEach(function (a, i) {
        if (!a) return;
        out.push({ dept: dept, kind: 'action', idx: i, text: str(a.what), owner: str(a.owner), due: str(a.due), status: str(a.status) });
      });
      (Array.isArray(d.decisions_needed) ? d.decisions_needed : []).forEach(function (dc, i) {
        if (!dc) return;
        out.push({ dept: dept, kind: 'decision', idx: i, text: str(dc.topic), owner: str(dc.decider), due: str(dc.due), status: str(dc.status) });
      });
    });
    return out;
  }

  function key(it) { return it.dept + '::' + it.kind + '::' + it.idx; }

  function bestOf(item, candidates) {
    var best = null, bestScore = 0;
    candidates.forEach(function (c) {
      var s = G.containment(item.text, c.text);
      if (s > bestScore) { bestScore = s; best = c; }
    });
    return bestScore >= MATCH_THRESH ? best : null;
  }

  // 같은 dept 우선, 없으면 dept 무관 전체 풀로 폴백. kind는 항상 일치해야 한다.
  function bestMatch(item, pool) {
    var sameDept = pool.filter(function (p) { return p.kind === item.kind && p.dept === item.dept; });
    var m = bestOf(item, sameDept);
    if (m) return m;
    var sameKind = pool.filter(function (p) { return p.kind === item.kind; });
    return bestOf(item, sameKind);
  }

  function diffBoards(prevBoard, curBoard) {
    var tags = {}, done = [];
    try {
      var cur = flatten(curBoard);

      if (!prevBoard) {
        cur.forEach(function (c) { tags[key(c)] = 'same'; });
        return { tags: tags, done: done };
      }

      var prev = flatten(prevBoard);

      cur.forEach(function (c) {
        var m = bestMatch(c, prev);
        if (!m) { tags[key(c)] = 'new'; return; }
        var becameConfirmed = c.status === '확정' && m.status !== '확정';
        if (becameConfirmed) {
          tags[key(c)] = 'done';
          done.push({ dept: c.dept, kind: c.kind, idx: c.idx, text: c.text, owner: c.owner, due: c.due, status: c.status, reason: 'confirmed' });
          return;
        }
        var changed = (c.owner !== m.owner) || (c.due !== m.due) || (c.status !== m.status);
        tags[key(c)] = changed ? 'changed' : 'same';
      });

      prev.forEach(function (p) {
        var m = bestMatch(p, cur);
        if (!m) {
          done.push({ dept: p.dept, kind: p.kind, idx: p.idx, text: p.text, owner: p.owner, due: p.due, status: p.status, reason: 'dropped' });
        }
      });

      return { tags: tags, done: done };
    } catch (e) {
      return { tags: {}, done: [] };
    }
  }

  var api = { diffBoards: diffBoards };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BoardDiff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
