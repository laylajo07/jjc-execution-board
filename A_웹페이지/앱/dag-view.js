/* 조정치 · DAG 뷰 — SVG 문자열만 만든다 (DOM 접근 없음, 순수).
   file:// 더블클릭 지원을 위해 클래식 스크립트. graph.js 다음에 로드되어야 한다. */
(function (root) {
  'use strict';

  var G = (typeof module !== 'undefined' && module.exports) ? require('./graph.js') : root.Graph;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  var DEPT_COLORS = ['#2563eb','#d97706','#0d9488','#7c3aed','#16a34a','#db2777','#0891b2','#ca8a04'];
  function deptColor(dept) {
    var s = 0, d = String(dept || '');
    for (var i = 0; i < d.length; i++) s = (s * 31 + d.charCodeAt(i)) >>> 0;
    return DEPT_COLORS[s % DEPT_COLORS.length];
  }

  var TOP = 28;

  function renderDag(g) {
  if (!g.nodes.length) return '';
  var W = G.NODE_W, H = G.NODE_H, GX = G.GAP_X, GY = G.GAP_Y;
  var maxD = 0, maxY = 0;
  g.nodes.forEach(function(n){ if(n.depth>maxD)maxD=n.depth; if(n.y>maxY)maxY=n.y; });
  var w = (maxD+1)*(W+GX)+40, h = maxY+H+56;
  var byId = {}; g.nodes.forEach(function(n){ byId[n.id]=n; });

  var out = '<svg viewBox="0 0 '+w+' '+h+'" class="dag" role="img" aria-label="크리티컬 패스 의존 그래프">';
  out += '<defs>'
      +  '<marker id="ah" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 z" fill="var(--line2)"/></marker>'
      +  '<marker id="ahc" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 z" fill="var(--chk)"/></marker>'
      +  '</defs>';

  // 열 라벨
  for (var d=0; d<=maxD; d++){
    var lx = 20 + d*(W+GX);
    out += '<text x="'+lx+'" y="16" class="dag-col">'+(d===0?'1단계 · 지금 시작 가능':(d+1)+'단계')+'</text>';
  }

  // 엣지를 노드보다 먼저 그려 뒤에 깔리게 한다
  g.edges.forEach(function(e){
    var a = byId[e.from], b = byId[e.to];
    var x1 = 20+a.x+W, y1 = TOP+a.y+H/2, x2 = 20+b.x, y2 = TOP+b.y+H/2;
    var mid = (x1+x2)/2;
    out += '<path d="M'+x1+','+y1+' C'+mid+','+y1+' '+mid+','+y2+' '+x2+','+y2+'"'
        +  ' class="'+(e.critical?'dag-e crit':'dag-e')+'" marker-end="url(#'+(e.critical?'ahc':'ah')+')"/>';
  });

  // 노드
  g.nodes.forEach(function(n){
    var x = 20+n.x, y = TOP+n.y;
    out += '<g class="dag-n'+(n.isBottleneck?' bott':'')+'" data-id="'+esc(n.id)+'" role="button" tabindex="0" aria-label="'+esc(n.task+' · '+n.dept)+'">'
        +  '<rect x="'+x+'" y="'+y+'" width="'+W+'" height="'+H+'" rx="8"/>'
        +  '<rect x="'+x+'" y="'+y+'" width="4" height="'+H+'" rx="2" fill="'+deptColor(n.dept)+'"/>'
        +  '<text x="'+(x+14)+'" y="'+(y+18)+'" class="dag-t">'+esc(clip(n.task,22))+'</text>'
        +  '<text x="'+(x+14)+'" y="'+(y+32)+'" class="dag-d">'+esc(clip(n.dept,18))+'</text>';
    if (n.isBottleneck) out += '<text x="'+(x+14)+'" y="'+(y+44)+'" class="dag-b">⚠ 후행 '+n.downstream+'개가 이걸 기다림</text>';
    out += '</g>';
    // external 스텁
    n.externals.forEach(function(lb, k){
      var sx = x - 96, sy = y + k*16;
      out += '<g class="dag-x"><rect x="'+sx+'" y="'+sy+'" width="88" height="14" rx="4"/>'
          +  '<text x="'+(sx+5)+'" y="'+(sy+10)+'">? '+esc(clip(lb,9))+'</text></g>';
    });
  });
  return out + '</svg>';
  }

  function renderDagWarnings(g) {
    if (!g.warnings.length && g.stats.mode === 'id') return '';
    var h = '<div class="dag-warn">';
    if (g.stats.mode === 'fuzzy') {
      h += '<div class="w-row w-info">구버전 결과 · 의존관계 ' + g.stats.edgeTotal + '개 중 '
        + g.stats.edgeResolved + '개만 연결됨. 정확한 그래프를 보려면 다시 분석하세요.</div>';
    }
    g.warnings.forEach(function (w) {
      if (w.type === 'cycle')       h += '<div class="w-row w-bad">순환 의존: ' + esc(w.detail) + '</div>';
      else if (w.type === 'empty')  h += '<div class="w-row w-info">진행 순서를 뽑을 수 없었습니다.</div>';
      else if (w.type === 'single') h += '<div class="w-row w-info">작업이 하나뿐이라 의존 관계가 없습니다.</div>';
      else if (w.type === 'unresolved' && g.stats.mode === 'id') h += '<div class="w-row w-info">' + esc(w.detail) + '</div>';
    });
    return h + '</div>';
  }

  function statusClass(st) { return { '확정': 'ok', '추정': 'est', '확인필요': 'chk' }[st] || 'chk'; }

  // 노드 상세 패널 본문(순수 문자열). detail은 board-derive.buildDetailMap의 항목.
  function nodePanelHtml(node, detail, graph) {
    detail = detail || { matched: false };
    var byId = {}; (graph.nodes || []).forEach(function (n) { byId[n.id] = n; });
    var preds = (graph.edges || []).filter(function (e) { return e.to === node.id; })
      .map(function (e) { return byId[e.from] ? byId[e.from].task : e.from; });

    var h = '<div class="np-head"><span class="np-dept" style="background:' + deptColor(node.dept) + '"></span>'
          + '<div><div class="np-title">' + esc(node.task) + '</div>'
          + '<div class="np-sub">' + esc(node.dept || '[미상]') + '</div></div></div>';

    if (node.isBottleneck) {
      h += '<div class="np-bott">⚠ 병목 · 후행 ' + node.downstream + '개가 이걸 기다림</div>';
    }

    if (detail.matched) {
      h += '<dl class="np-facts">'
        + '<dt>담당</dt><dd>' + esc(detail.owner || '미정') + '</dd>'
        + '<dt>기한</dt><dd>' + esc(detail.due || '미정') + '</dd>'
        + '<dt>상태</dt><dd>' + (detail.status ? '<span class="tag ' + statusClass(detail.status) + '">' + esc(detail.status) + '</span>' : '미정') + '</dd>'
        + '</dl>';
      if (detail.basis) h += '<div class="np-basis">↳ ' + esc(detail.basis) + '</div>';
    } else {
      h += '<div class="np-note">담당·기한·상태는 위 <b>부서별 실행 항목</b> 표에서 확인하세요.</div>';
    }

    if (preds.length) {
      h += '<div class="np-block"><div class="np-label">선행</div>'
        + preds.map(function (t) { return '<div class="np-dep">← ' + esc(t) + '</div>'; }).join('') + '</div>';
    }
    if (node.externals && node.externals.length) {
      h += '<div class="np-block"><div class="np-label">외부 선행 · 회의록에 없음</div>'
        + node.externals.map(function (x) { return '<div class="np-dep np-ext">? ' + esc(x) + '</div>'; }).join('') + '</div>';
    }
    return h;
  }

  var api = { renderDag: renderDag, renderDagWarnings: renderDagWarnings, deptColor: deptColor, nodePanelHtml: nodePanelHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DagView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
