/* 조정치 · 보드 파생 — 그래프 + 보드데이터 → 뷰모델. 순수(DOM 접근 없음).
   graph.js 다음에 로드되어야 한다. file:// 지원을 위해 클래식 스크립트. A·B 바이트 동일. */
(function (root) {
  'use strict';

  var G = (typeof module !== 'undefined' && module.exports) ? require('./graph.js') : root.Graph;

  var JOIN_THRESH = 0.5;   // 조인은 특정 담당/기한을 드러내므로 하드
  var RANK_THRESH = 0.35;  // 랭킹은 소프트 신호 — gap 노이즈 어미로 희석되어 느슨(스펙 §4-1)

  function bestMatch(query, candidates, getText, thresh) {
    var best = null, bestScore = 0;
    for (var i = 0; i < candidates.length; i++) {
      var s = G.containment(query, getText(candidates[i]));
      if (s > bestScore) { bestScore = s; best = candidates[i]; }
    }
    return bestScore >= thresh ? best : null;
  }

  function itemText(a) { return a.what || ''; }
  function nodeText(n) { return n.task || ''; }

  // 노드 → {owner,due,status,basis,matched}. action_items가 유일 출처, 여기선 조인만 한다.
  function buildDetailMap(graph, byDepartment) {
    var depts = byDepartment || [];
    var byDept = {}, all = [];
    depts.forEach(function (d) {
      var items = d.action_items || [];
      byDept[d.dept] = items;
      items.forEach(function (a) { all.push(a); });
    });
    var map = {};
    (graph.nodes || []).forEach(function (n) {
      var m = bestMatch(n.task, byDept[n.dept] || [], itemText, JOIN_THRESH);
      if (!m) m = bestMatch(n.task, all, itemText, JOIN_THRESH);
      map[n.id] = m
        ? { owner: m.owner || '', due: m.due || '', status: m.status || '', basis: m.basis || '', matched: true }
        : { owner: '', due: '', status: '', basis: '', matched: false };
    });
    return map;
  }

  // id에서 도달 가능한 후행 id 집합
  function reachable(graph, id) {
    var succ = {};
    (graph.nodes || []).forEach(function (n) { succ[n.id] = []; });
    (graph.edges || []).forEach(function (e) { if (succ[e.from]) succ[e.from].push(e.to); });
    var seen = {}, stack = [id];
    while (stack.length) {
      var cur = stack.pop();
      (succ[cur] || []).forEach(function (t) { if (!seen[t]) { seen[t] = true; stack.push(t); } });
    }
    return Object.keys(seen);
  }

  // 확인필요/가정 문자열을 그래프 연결도로 우선순위화(내림차순 정렬해 반환).
  function rankItems(graph, items) {
    var arr = (items || []).filter(Boolean);
    var byId = {}; (graph.nodes || []).forEach(function (n) { byId[n.id] = n; });
    var scored = arr.map(function (text, i) {
      var m = bestMatch(text, graph.nodes || [], nodeText, RANK_THRESH);
      var cpScore = 0, deptSpan = 0, downstream = 0;
      if (m) {
        downstream = m.downstream || 0;
        var seen = {};
        reachable(graph, m.id).forEach(function (rid) {
          var dp = byId[rid] && byId[rid].dept; if (dp) seen[dp] = true;
        });
        deptSpan = Object.keys(seen).length;
        cpScore = m.isBottleneck ? 2 : (downstream > 0 ? 1 : 0);
      } else {
        var hitExt = (graph.nodes || []).some(function (n) {
          return (n.externals || []).some(function (lb) { return G.containment(text, lb) >= RANK_THRESH; });
        });
        if (hitExt) cpScore = 1;
      }
      return { text: text, cpScore: cpScore, deptSpan: deptSpan, downstream: downstream, _i: i };
    });
    scored.sort(function (a, b) {
      return (b.cpScore - a.cpScore) || (b.deptSpan - a.deptSpan) || (b.downstream - a.downstream) || (a._i - b._i);
    });
    return scored;
  }

  // ── 지시사항 14: 회의록 품질 점수 ──
  // "미정" 판정: 비었거나 미정·미상·[미상]·- (trim 후 비교).
  function isBlank(v) {
    v = (v == null ? '' : String(v)).trim();
    return !v || v === '미정' || v === '미상' || v === '[미상]' || v === '-';
  }

  // 순수·결정적·DOM 미접근. board가 null/이상해도 예외를 던지지 않고 0점 상태를 돌려준다.
  function qualityScore(board) {
    var zero = { score: 100, ownerMissing: 0, dueMissing: 0, decisionOpen: 0, itemCount: 0, decisionCount: 0, total: 0 };
    try {
      var depts = (board && Array.isArray(board.by_department)) ? board.by_department : [];
      var items = [], decisions = [];
      depts.forEach(function (d) {
        if (!d) return;
        (Array.isArray(d.action_items) ? d.action_items : []).forEach(function (a) { if (a) items.push(a); });
        (Array.isArray(d.documents) ? d.documents : []).forEach(function (doc) { if (doc) items.push(doc); });
        (Array.isArray(d.decisions_needed) ? d.decisions_needed : []).forEach(function (dc) { if (dc) decisions.push(dc); });
      });
      var ownerMissing = 0, dueMissing = 0, decisionOpen = 0;
      items.forEach(function (it) {
        if (isBlank(it.owner)) ownerMissing++;
        if (isBlank(it.due)) dueMissing++;
      });
      decisions.forEach(function (dc) {
        if (isBlank(dc.decider)) ownerMissing++;
        if (isBlank(dc.due)) dueMissing++;
        if (String(dc.status == null ? '' : dc.status).trim() !== '확정') decisionOpen++;
      });
      var ownerSlots = items.length + decisions.length;
      var dueSlots = items.length + decisions.length;
      var decisionSlots = decisions.length;
      var total = ownerSlots + dueSlots + decisionSlots;
      var missing = ownerMissing + dueMissing + decisionOpen;
      var score = total > 0 ? Math.round((1 - missing / total) * 100) : 100;
      return { score: score, ownerMissing: ownerMissing, dueMissing: dueMissing, decisionOpen: decisionOpen, itemCount: items.length, decisionCount: decisions.length, total: total };
    } catch (e) {
      return zero;
    }
  }

  var api = { buildDetailMap: buildDetailMap, rankItems: rankItems, qualityScore: qualityScore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BoardDerive = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
