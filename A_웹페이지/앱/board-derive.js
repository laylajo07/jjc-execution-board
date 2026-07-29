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
  // 예시(제안) 목표일은 확정된 기한이 아니므로 점수에선 '미확정'으로 집계한다.
  function isUnsetDue(v) {
    return isBlank(v) || /예시/.test(String(v == null ? '' : v));
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
        if (isUnsetDue(it.due)) dueMissing++;
      });
      decisions.forEach(function (dc) {
        if (isBlank(dc.decider)) ownerMissing++;
        if (isUnsetDue(dc.due)) dueMissing++;
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

  // ── 사용자 친화 타이틀 ──
  // meeting.title에서 앞머리 날짜 표기([2026-07-21]/2026.7.21 등)를 떼고, 너무 길면 잘라
  // 화면 상단 제목으로 쓰기 좋은 짧은 문자열을 만든다. 제목이 없으면 headline로 폴백,
  // 그것도 없으면 '회의 실행보드'. 순수·결정적·DOM 미접근.
  function friendlyTitle(board) {
    try {
      var mt = (board && board.meeting) || {};
      var t = (mt.title == null ? '' : String(mt.title)).trim();
      // 앞머리 날짜 접두 제거: "[2026-07-21] ", "2026.07.21 ", "7/21 " 등
      t = t.replace(/^\[?\s*\d{4}\s*[-.\/]\s*\d{1,2}\s*[-.\/]\s*\d{1,2}\s*\]?\s*[-:·]?\s*/, '').trim();
      if (!t || t === '[미상]' || t === '제목 미상') {
        t = (board && board.headline != null ? String(board.headline) : '').trim();
      }
      if (!t) return '회의 실행보드';
      var MAX = 34;
      if (t.length > MAX) {
        var cut = t.slice(0, MAX).replace(/[\s,·]+\S*$/, '');
        t = (cut.length >= 12 ? cut : t.slice(0, MAX)) + '…';
      }
      return t || '회의 실행보드';
    } catch (e) { return '회의 실행보드'; }
  }

  // 회의록 파일명 등에서 회차 번호(양의 정수)를 추론한다. 없으면 null(지시 15).
  // 우선순위: 'N차'/'N회차' → '버전 N' → 문자열 내 첫 정수. 순수 — 입력 문자열만 본다.
  function inferRoundNo(name) {
    var s = (name == null ? '' : String(name));
    var m = s.match(/(\d+)\s*차/) || s.match(/버전\s*(\d+)/);
    if (!m) {
      var m2 = s.match(/(\d+)/);
      // 'N차'/'버전 N'처럼 회차를 명시하는 패턴이 전혀 없을 때만 쓰는 최후 폴백이라, 날짜 형식
      // 파일명("2026-03-15 회의.md", "20260315_회의록.md" 등)에서 연도나 전체 날짜를 회차번호로
      // 오인하기 쉽다(자체감사 발견 — 여기서 잘못 뽑히면 이후 자동 채번까지 전부 오염된다).
      // 4자리 이상 숫자는 실제 회차번호로 보기 어려우니 신뢰하지 않는다.
      if (m2 && m2[1].length >= 4) return null;
      m = m2;
    }
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return (Number.isFinite(n) && n >= 1) ? n : null;
  }

  // ── 회의 성격 자동 판단 + 성격별 품질 점수(사용자 요청) ──
  // 회의록 제목/헤드라인에 성격을 드러내는 표현이 있으면 최우선으로 신뢰한다(작성자가 직접
  // 붙인 표현이 가장 직접적인 신호). 명확한 표현이 없으면 구조적 신호로 대체 추론한다:
  // 이전 회차(diff)가 아예 없으면(=첫 회차) 기획/킥오프로, 완료율이 매우 높고 미결이 전혀
  // 없으면 완료보고로, 그 외에는 중간점검으로 본다.
  var MEETING_TYPE_LABEL = { planning: '📋 기획 회의', midcheck: '🔍 중간 점검', completion: '✅ 완료 보고' };

  // action_items/documents/decisions_needed 전체 대비 status==='확정' 비율. 순수·결정적.
  function completionRate(board) {
    try {
      var depts = (board && Array.isArray(board.by_department)) ? board.by_department : [];
      var total = 0, confirmed = 0;
      depts.forEach(function (d) {
        if (!d) return;
        ['action_items', 'documents', 'decisions_needed'].forEach(function (k) {
          (Array.isArray(d[k]) ? d[k] : []).forEach(function (it) {
            if (!it) return;
            total++;
            if (String(it.status == null ? '' : it.status).trim() === '확정') confirmed++;
          });
        });
      });
      return total > 0 ? confirmed / total : 0;
    } catch (e) { return 0; }
  }

  // diff는 index.html의 BoardDiff.diffBoards(prevBoard,curBoard) 결과(이전 회차 없으면 null).
  function classifyMeetingType(board, diff) {
    try {
      var mt = (board && board.meeting) || {};
      var text = [mt.title, board && board.headline].filter(Boolean).join(' ');
      if (/킥오프|기획/.test(text)) return 'planning';
      if (/중간\s*점검|점검/.test(text)) return 'midcheck';
      if (/완료\s*보고|완료보고|오픈|종료\s*보고/.test(text)) return 'completion';
      if (!diff) return 'planning';   // 이전 회차 자체가 없으면 첫 회차 = 기획/킥오프
      var q = qualityScore(board);
      if (completionRate(board) >= 0.85 && q.decisionOpen === 0 && q.ownerMissing === 0) return 'completion';
      return 'midcheck';
    } catch (e) { return 'planning'; }
  }

  // 회의 성격별 점수(0-100 정수). qualityScore()의 세부 항목(ownerMissing 등)은 그대로 두고
  // "요약 화면 상단 큰 숫자"만 성격에 맞게 다시 계산한다 — qs-stat 칩·품질 트렌드 사유 등
  // 다른 소비자는 원래 qualityScore()를 그대로 계속 쓴다.
  //   기획/킥오프: 기존 산정 방식 그대로(미결·담당자 미정·기한 미확정 기준, 지시사항 14).
  //   중간점검: 이전 회차 대비 이번에 새로 확정된 항목 비율(진행률) + 새로 확정된 의사결정 보너스.
  //   완료보고: 전체 완료율을 60%, 기존 산정 점수(미결·담당자·기한)를 40% 비중으로 반영.
  function meetingTypeScore(board, type, diff) {
    var q = qualityScore(board);
    try {
      var hasItems = (q.itemCount + q.decisionCount) > 0;
      if (type === 'completion') {
        // 완료 보고 회의는 개별 항목을 다시 나열하지 않고 "모두 완료됐다"고 서술로만 보고하는
        // 경우가 실제로 있다(자체검증에서 발견) — 그러면 by_department가 통째로 비어 completionRate가
        // 0/0=0이 되어 오히려 낮은 점수로 보인다. 항목이 하나도 없는 완료 보고는 전부 완료로 간주한다.
        if (!hasItems) return 100;
        var cr = completionRate(board);
        return Math.max(0, Math.min(100, Math.round(cr * 100 * 0.6 + q.score * 0.4)));
      }
      if (type === 'midcheck') {
        if (!diff || !Array.isArray(diff.done)) return q.score;   // 비교 기준 없으면 기존 점수로 폴백
        var confirmedNow = diff.done.filter(function (d) { return d.reason === 'confirmed'; }).length;
        var newDecisions = diff.done.filter(function (d) { return d.reason === 'confirmed' && d.kind === 'decision'; }).length;
        var totalItems = q.itemCount + q.decisionCount;
        var progressRatio = totalItems > 0 ? confirmedNow / totalItems : 0;
        var decisionBonus = Math.min(30, newDecisions * 10);
        return Math.max(0, Math.min(100, Math.round(progressRatio * 70 + decisionBonus)));
      }
      return q.score;
    } catch (e) { return q.score; }
  }

  var api = { buildDetailMap: buildDetailMap, rankItems: rankItems, qualityScore: qualityScore, friendlyTitle: friendlyTitle, inferRoundNo: inferRoundNo,
    classifyMeetingType: classifyMeetingType, meetingTypeScore: meetingTypeScore, completionRate: completionRate, MEETING_TYPE_LABEL: MEETING_TYPE_LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BoardDerive = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
