/* 조정치 · 프로젝트 히스토리 diff — 회차(prev/cur) 두 보드를 비교해 신규/완료/변경을 태그한다.
   순수(DOM 접근 없음). graph.js 다음에 로드되어야 한다(containment 재사용).
   file:// 지원을 위해 클래식 스크립트. A·B 바이트 동일.

   diffBoards(prevBoard, curBoard) → { tags, done }

   반환 형태:
   - tags: { '<deptIdx>::<dept>::<kind>::<idx>': 'new'|'changed'|'done'|'same' }
       curBoard의 항목별 태그. key는 그 항목이 속한 by_department 배열 내 0-based
       순번(deptIdx) + 부서명(dept) + 종류(kind) + 그 부서·종류 배열 안에서의
       0-based 순번(idx)으로 만든다(렌더러가 curBoard.by_department를 그대로 순회하며
       조회할 수 있게 하기 위함). deptIdx가 있어 같은 dept명이 by_department에
       두 번 이상 나와도(모델이 부서를 중복 출력하는 경우가 실제로 있다) key가 충돌하지
       않는다 — dept명만으로는 어느 항목의 태그인지 구분이 안 돼 서로 덮어써 버린다.
       kind: 'action'(action_items) | 'doc'(documents) | 'decision'(decisions_needed)
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

   매칭 규칙: 항목 텍스트(action_items의 what / documents의 doc / decisions_needed의 topic)를 graph.js의
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

  // board-derive.js isBlank와 동일 판정(로컬 복제 — 모듈 독립성 유지, house style).
  // "미정" 취급: 비었거나 미정·미상·[미상]·- (trim 후 비교). owner/due/decider 비교에 쓴다.
  function isBlank(v) {
    v = (v == null ? '' : String(v)).trim();
    return !v || v === '미정' || v === '미상' || v === '[미상]' || v === '-';
  }

  // owner/due(및 decider) 비교용 동치 판정 — 둘 다 "미정" 취급(빈 값·미정·미상·[미상]·-)이면
  // 문자열이 달라도 같은 값으로 본다. status는 이 함수를 쓰지 않고 리터럴 비교한다.
  function sameFieldValue(a, b) {
    if (isBlank(a) && isBlank(b)) return true;
    return a === b;
  }

  // by_department → 평탄화된 항목 목록 [{deptIdx, dept, kind, idx, text, owner, due, status}]
  function flatten(board) {
    var depts = (board && Array.isArray(board.by_department)) ? board.by_department : [];
    var out = [];
    depts.forEach(function (d, di) {
      if (!d) return;
      var dept = str(d.dept);
      (Array.isArray(d.action_items) ? d.action_items : []).forEach(function (a, i) {
        if (!a) return;
        out.push({ deptIdx: di, dept: dept, kind: 'action', idx: i, text: str(a.what), owner: str(a.owner), due: str(a.due), status: str(a.status) });
      });
      (Array.isArray(d.documents) ? d.documents : []).forEach(function (doc, i) {
        if (!doc) return;
        out.push({ deptIdx: di, dept: dept, kind: 'doc', idx: i, text: str(doc.doc), owner: str(doc.owner), due: str(doc.due), status: str(doc.status) });
      });
      (Array.isArray(d.decisions_needed) ? d.decisions_needed : []).forEach(function (dc, i) {
        if (!dc) return;
        out.push({ deptIdx: di, dept: dept, kind: 'decision', idx: i, text: str(dc.topic), owner: str(dc.decider), due: str(dc.due), status: str(dc.status) });
      });
    });
    return out;
  }

  function key(it) { return it.deptIdx + '::' + it.dept + '::' + it.kind + '::' + it.idx; }

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
        var changed = !sameFieldValue(c.owner, m.owner) || !sameFieldValue(c.due, m.due) || (c.status !== m.status);
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

  // ── 회차 간 주요 변경점 요약(메인 노출용) ──
  // diffBoards의 결과(diff)와 현재 보드(curBoard)로부터 신규/변경/완료 건수와
  // 대표 항목 목록을 만든다. 렌더러가 보드 최상단에 요약 카드로 표시한다.
  //   { added, changed, done, total, items: [{tag, dept, kind, label, text, reason?}] }
  //   tag: 'new'|'changed'|'done'. items는 신규→변경→완료 순, 최대 6개.
  //   done 수는 diff.done(=confirmed+dropped) 길이. diff가 없으면 전부 0.
  // 순수·불변·DOM 미접근. 기형 입력에도 예외를 던지지 않는다.
  var KIND_LABEL = { action: '할 일', doc: '문서', decision: '의사결정' };
  function changeDigest(diff, curBoard) {
    var out = { added: 0, changed: 0, done: 0, total: 0, items: [] };
    try {
      if (!diff || !diff.tags) return out;
      var cur = flatten(curBoard);
      var adds = [], chgs = [];
      cur.forEach(function (c) {
        var t = diff.tags[key(c)];
        if (t === 'new') { out.added++; adds.push({ tag: 'new', dept: c.dept, kind: c.kind, label: KIND_LABEL[c.kind] || '', text: c.text }); }
        else if (t === 'changed') { out.changed++; chgs.push({ tag: 'changed', dept: c.dept, kind: c.kind, label: KIND_LABEL[c.kind] || '', text: c.text }); }
      });
      var dones = (diff.done || []).map(function (dn) {
        return { tag: 'done', dept: dn.dept, kind: dn.kind, label: KIND_LABEL[dn.kind] || '', text: dn.text, reason: dn.reason };
      });
      out.done = dones.length;
      out.total = out.added + out.changed + out.done;
      out.items = adds.concat(chgs).concat(dones).slice(0, 6);
      return out;
    } catch (e) { return { added: 0, changed: 0, done: 0, total: 0, items: [] }; }
  }

  var api = { diffBoards: diffBoards, changeDigest: changeDigest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BoardDiff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
