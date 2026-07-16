/* 조정치 · 그래프 엔진 (순수 함수 — DOM 접근 없음)
   모델은 작업·부서·선행만 적는다. 순서·후행·병목·깊이·좌표는 전부 여기서 계산한다.
   file:// 더블클릭을 지원해야 하므로 ES 모듈이 아닌 클래식 스크립트다. */
(function (root) {
  'use strict';

  var NODE_W = 170, NODE_H = 48, GAP_X = 60, GAP_Y = 14;

  function makeNodes(seq) {
    return seq.map(function (s, i) {
      return {
        id: (s && s.id) ? String(s.id) : 'T' + (i + 1),
        task: String((s && s.task) || ''),
        dept: String((s && s.dept) || ''),
        externals: ((s && s.blocked_by_external) || []).map(String),
        depth: 0, downstream: 0, isBottleneck: false, x: 0, y: 0,
        _i: i
      };
    });
  }

  // 선행 목록 → 엣지. 해석 실패한 것은 externals로 강등한다.
  function buildEdges(seq, nodes, index) {
    var edges = [], total = 0, resolved = 0;
    seq.forEach(function (s, i) {
      var self = nodes[i];
      ((s && s.blocked_by) || []).forEach(function (b) {
        total++;
        var from = String(b);
        if (index[from] && from !== self.id) {
          edges.push({ from: from, to: self.id, critical: false });
          resolved++;
        } else {
          self.externals.push(from);   // 없는 id를 가리킴 → 정직하게 external로
        }
      });
    });
    return { edges: edges, total: total, resolved: resolved };
  }

  // DFS로 back edge를 찾아 제거한다. 제거한 것은 반드시 경고로 알린다.
  function detectCycles(nodes, edges) {
    var adj = {}, state = {}, backs = [], cycles = [], stack = [];
    nodes.forEach(function (n) { adj[n.id] = []; state[n.id] = 0; });
    edges.forEach(function (e) { adj[e.from].push(e); });

    function dfs(id) {
      state[id] = 1; stack.push(id);
      adj[id].forEach(function (e) {
        if (state[e.to] === 1) {
          backs.push(e);
          var at = stack.indexOf(e.to);
          cycles.push(stack.slice(at).concat(e.to).join('→'));
        } else if (state[e.to] === 0) {
          dfs(e.to);
        }
      });
      stack.pop(); state[id] = 2;
    }
    nodes.forEach(function (n) { if (state[n.id] === 0) dfs(n.id); });

    var kept = edges.filter(function (e) { return backs.indexOf(e) === -1; });
    return { edges: kept, cycles: cycles };
  }

  function predMap(nodes, edges) {
    var m = {};
    nodes.forEach(function (n) { m[n.id] = []; });
    edges.forEach(function (e) { m[e.to].push(e.from); });
    return m;
  }

  function succMap(nodes, edges) {
    var m = {};
    nodes.forEach(function (n) { m[n.id] = []; });
    edges.forEach(function (e) { m[e.from].push(e.to); });
    return m;
  }

  // 최장 경로 깊이 — 모든 선행보다 반드시 뒤에 놓이게 한다.
  function computeDepth(nodes, preds) {
    var depth = {}, busy = {};
    function d(id) {
      if (depth[id] != null) return depth[id];
      busy[id] = true;
      var m = 0;
      preds[id].forEach(function (p) {
        if (!busy[p]) m = Math.max(m, d(p) + 1);
      });
      busy[id] = false;
      depth[id] = m;
      return m;
    }
    nodes.forEach(function (n) { n.depth = d(n.id); });
  }

  // 도달 가능한 후행 집합의 크기 = 이 작업이 막고 있는 작업 수
  function computeDownstream(nodes, succ) {
    var memo = {};
    function reach(id) {
      if (memo[id]) return memo[id];
      var set = {};
      memo[id] = set;
      succ[id].forEach(function (t) {
        set[t] = true;
        var sub = reach(t);
        for (var k in sub) if (Object.prototype.hasOwnProperty.call(sub, k)) set[k] = true;
      });
      return set;
    }
    nodes.forEach(function (n) { n.downstream = Object.keys(reach(n.id)).length; });
  }

  function markBottleneck(nodes, edges) {
    var max = 0;
    nodes.forEach(function (n) { if (n.downstream > max) max = n.downstream; });
    if (max <= 0) return;
    nodes.forEach(function (n) { n.isBottleneck = (n.downstream === max); });
    var hot = {};
    nodes.forEach(function (n) { if (n.isBottleneck) hot[n.id] = true; });
    edges.forEach(function (e) { e.critical = !!hot[e.from]; });
  }

  function buildGraph(sequence) {
    var seq = Array.isArray(sequence) ? sequence : [];
    if (!seq.length) {
      return {
        nodes: [], edges: [],
        warnings: [{ type: 'empty', detail: '진행 순서 데이터가 없습니다' }],
        stats: { edgeTotal: 0, edgeResolved: 0, mode: 'id' }
      };
    }

    var nodes = makeNodes(seq);
    var index = {};
    nodes.forEach(function (n) { index[n.id] = n; });

    var built = buildEdges(seq, nodes, index);
    var warnings = [];

    var cyc = detectCycles(nodes, built.edges);
    var edges = cyc.edges;
    cyc.cycles.forEach(function (c) {
      warnings.push({ type: 'cycle', detail: c });
    });

    var unresolved = built.total - built.resolved;
    if (unresolved > 0) {
      warnings.push({
        type: 'unresolved',
        detail: '선행 ' + built.total + '개 중 ' + unresolved + '개를 작업 목록에서 찾지 못해 별도 표시합니다'
      });
    }
    if (nodes.length === 1) {
      warnings.push({ type: 'single', detail: '작업이 하나뿐이라 의존 관계가 없습니다' });
    }

    var preds = predMap(nodes, edges);
    var succ = succMap(nodes, edges);
    computeDepth(nodes, preds);
    computeDownstream(nodes, succ);
    markBottleneck(nodes, edges);

    return {
      nodes: nodes, edges: edges, warnings: warnings,
      stats: { edgeTotal: built.total, edgeResolved: built.resolved, mode: 'id' }
    };
  }

  var api = {
    buildGraph: buildGraph,
    NODE_W: NODE_W, NODE_H: NODE_H, GAP_X: GAP_X, GAP_Y: GAP_Y
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Graph = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
