/* 조정치 · 그래프 엔진 (순수 함수 — DOM 접근 없음)
   모델은 작업·부서·선행만 적는다. 순서·후행·병목·깊이·좌표는 전부 여기서 계산한다.
   file:// 더블클릭을 지원해야 하므로 ES 모듈이 아닌 클래식 스크립트다. */
(function (root) {
  'use strict';

  var NODE_W = 170, NODE_H = 48, GAP_X = 60, GAP_Y = 14;

  var SUFFIX = /(작성|확정|준비|검토|완료|진행)$/;

  function normalize(s) {
    var n = String(s == null ? '' : s).toLowerCase()
      .replace(/[\s·→\-—()[\]{}.,/'"`:;!?~]/g, '');
    return n.replace(SUFFIX, '');
  }

  function bigrams(s) {
    var n = normalize(s), set = {}, i;
    if (n.length < 2) { if (n) set[n] = true; return set; }
    for (i = 0; i < n.length - 1; i++) set[n.slice(i, i + 2)] = true;
    return set;
  }

  // 포함 계수(overlap coefficient). Jaccard가 아닌 이유: 짧은 별칭이 긴 정식명칭을
  // 가리키는 게 이 데이터의 지배적 패턴이라, 길이 차이에 벌점을 주면 안 된다.
  function containment(a, b) {
    var A = bigrams(a), B = bigrams(b);
    var ka = Object.keys(A), kb = Object.keys(B);
    if (!ka.length || !kb.length) return 0;
    var inter = 0;
    ka.forEach(function (k) { if (B[k]) inter++; });
    return inter / Math.min(ka.length, kb.length);
  }

  // 애매하면 연결하지 않는다. 틀린 화살표가 없는 화살표보다 나쁘다.
  function resolveFuzzy(label, nodes, selfId) {
    var scored = nodes
      .filter(function (n) { return n.id !== selfId; })
      .map(function (n) { return { id: n.id, score: containment(label, n.task) }; })
      .sort(function (x, y) { return y.score - x.score; });
    if (!scored.length) return null;
    var best = scored[0], second = scored[1];
    if (best.score < 0.5) return null;
    if (second && (best.score - second.score) < 0.15) return null;
    return best.id;
  }

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
  function buildEdges(seq, nodes, index, mode) {
    var edges = [], total = 0, resolved = 0;
    seq.forEach(function (s, i) {
      var self = nodes[i];
      ((s && s.blocked_by) || []).forEach(function (b) {
        total++;
        var label = String(b);
        var from = (mode === 'id') ? label : resolveFuzzy(label, nodes, self.id);
        if (from && index[from] && from !== self.id) {
          edges.push({ from: from, to: self.id, critical: false });
          resolved++;
        } else {
          self.externals.push(label);
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

  // 열 = 깊이. 열 안 순서는 선행들의 슬롯 평균(barycenter)으로 정해 교차를 줄인다.
  // 동점은 원본 배열 순서로 깨서 항상 같은 결과가 나오게 한다.
  function layout(nodes, preds) {
    var byDepth = {};
    nodes.forEach(function (n) {
      (byDepth[n.depth] = byDepth[n.depth] || []).push(n);
    });
    var slot = {};

    function bary(n) {
      var ps = preds[n.id].filter(function (p) { return slot[p] != null; });
      if (!ps.length) return n._i;
      var s = 0;
      ps.forEach(function (p) { s += slot[p]; });
      return s / ps.length;
    }

    Object.keys(byDepth).map(Number).sort(function (a, b) { return a - b; })
      .forEach(function (d) {
        var col = byDepth[d];
        col.sort(function (a, b) {
          var ba = bary(a), bb = bary(b);
          if (ba !== bb) return ba - bb;
          return a._i - b._i;
        });
        col.forEach(function (n, i) {
          slot[n.id] = i;
          n.x = d * (NODE_W + GAP_X);
          n.y = i * (NODE_H + GAP_Y);
        });
      });
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

    // id 필드가 하나라도 있으면 신스키마로 간주한다.
    var mode = seq.some(function (s) { return s && s.id; }) ? 'id' : 'fuzzy';

    var nodes = makeNodes(seq);
    var index = {};
    nodes.forEach(function (n) { index[n.id] = n; });

    var built = buildEdges(seq, nodes, index, mode);
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
    layout(nodes, preds);

    return {
      nodes: nodes, edges: edges, warnings: warnings,
      stats: { edgeTotal: built.total, edgeResolved: built.resolved, mode: mode }
    };
  }

  var api = {
    buildGraph: buildGraph,
    normalize: normalize, containment: containment,
    NODE_W: NODE_W, NODE_H: NODE_H, GAP_X: GAP_X, GAP_Y: GAP_Y
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Graph = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
