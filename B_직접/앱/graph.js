/* 조정치 · 그래프 엔진 (순수 함수 — DOM 접근 없음)
   모델은 작업·부서·선행만 적는다. 순서·후행·병목·깊이·좌표는 전부 여기서 계산한다.
   file:// 더블클릭을 지원해야 하므로 ES 모듈이 아닌 클래식 스크립트다. */
(function (root) {
  'use strict';

  var NODE_W = 170, NODE_H = 48, GAP_X = 100, GAP_Y = 32;

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

  // 열 = 깊이. 열 내부 순서는 반복 barycenter(선행/후행 교대)로 교차를 줄인다.
  // 결정적: 동점은 원본 배열 index(_i)로 깬다.
  function orderRanks(nodes, preds, succ) {
    var byDepth = {};
    nodes.forEach(function (n) { (byDepth[n.depth] = byDepth[n.depth] || []).push(n); });
    var depths = Object.keys(byDepth).map(Number).sort(function (a, b) { return a - b; });
    depths.forEach(function (d) { byDepth[d].sort(function (a, b) { return a._i - b._i; }); });
    var pos = {};
    function reindex() { depths.forEach(function (d) { byDepth[d].forEach(function (n, i) { pos[n.id] = i; }); }); }
    reindex();
    function bary(n, adj) {
      var ns = adj[n.id].filter(function (m) { return pos[m] != null; });
      if (!ns.length) return pos[n.id];
      var s = 0; ns.forEach(function (m) { s += pos[m]; }); return s / ns.length;
    }
    for (var it = 0; it < 4; it++) {
      var down = (it % 2 === 0);
      (down ? depths : depths.slice().reverse()).forEach(function (d) {
        var adj = down ? preds : succ;
        byDepth[d] = byDepth[d]
          .map(function (n) { return { n: n, b: bary(n, adj) }; })
          .sort(function (a, b) { return (a.b - b.b) || (a.n._i - b.n._i); })
          .map(function (o) { return o.n; });
        reindex();
      });
    }
    return byDepth;
  }

  function layout(nodes, preds, succ) {
    var byDepth = orderRanks(nodes, preds, succ);
    Object.keys(byDepth).map(Number).forEach(function (d) {
      byDepth[d].forEach(function (n, i) {
        n.x = d * (NODE_W + GAP_X);
        n.y = i * (NODE_H + GAP_Y);
      });
    });
    return byDepth;
  }

  // 열 colNodes의 박스(세로 밴드)를 피해 targetY에 가장 가까운 y를 고른다.
  function clearY(colNodes, targetY) {
    if (!colNodes.length) return targetY;
    var pad = 10;
    var bands = colNodes.map(function (n) { return [n.y - pad, n.y + NODE_H + pad]; })
      .sort(function (a, b) { return a[0] - b[0]; });
    for (var i = 0; i < bands.length; i++) {
      if (targetY >= bands[i][0] && targetY <= bands[i][1]) {
        return (targetY - bands[i][0] <= bands[i][1] - targetY) ? bands[i][0] : bands[i][1];
      }
    }
    return targetY;
  }

  // 각 엣지에 route(절대좌표 폴리라인)를 붙인다:
  //   소스 우변 포트 → (긴 엣지면 중간 열을 안전한 y로 수평 통과) → 타깃 좌변 포트.
  // 포트는 노드 좌우변에서 세로로 분산해 겹침을 줄인다.
  function computeRoutes(nodes, edges, byDepth) {
    var byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
    var out = {}, inc = {};
    nodes.forEach(function (n) { out[n.id] = []; inc[n.id] = []; });
    edges.forEach(function (e) { out[e.from].push(e); inc[e.to].push(e); });

    function port(node, list, e, otherKey) {
      var sorted = list.slice().sort(function (a, b) {
        var oa = byId[a[otherKey]], ob = byId[b[otherKey]];
        return ((oa ? oa.y : 0) - (ob ? ob.y : 0)) || (a.from + '>' + a.to).localeCompare(b.from + '>' + b.to);
      });
      return node.y + Math.round(NODE_H * (sorted.indexOf(e) + 1) / (sorted.length + 1));
    }

    edges.forEach(function (e) {
      var a = byId[e.from], b = byId[e.to];
      var sx = a.x + NODE_W, sy = port(a, out[a.id], e, 'to');
      var tx = b.x, ty = port(b, inc[b.id], e, 'from');
      var pts = [{ x: sx, y: sy }];
      for (var d = a.depth + 1; d < b.depth; d++) {
        var colX = d * (NODE_W + GAP_X);
        var lineY = sy + (ty - sy) * ((colX - sx) / (tx - sx || 1));
        var safe = clearY(byDepth[d] || [], lineY);
        pts.push({ x: colX, y: safe });
        pts.push({ x: colX + NODE_W, y: safe });
      }
      pts.push({ x: tx, y: ty });
      e.route = pts;
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
    var byDepth = layout(nodes, preds, succ);
    computeRoutes(nodes, edges, byDepth);

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
