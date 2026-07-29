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

  // 전각(한글·한자·가나 등) 문자 판정 — 폭 추정에만 쓴다. 실제 canvas measureText 없이
  // 순수하게 줄바꿈 지점을 계산해야 해서(테스트 재현성·file:// 지원), 전각은 폰트 크기와
  // 거의 같은 폭, 그 외(영문·숫자·기호)는 대략 0.58배로 잡는 근사치를 쓴다.
  function isWideChar(ch) {
    var c = ch.codePointAt(0);
    return (c >= 0x1100 && c <= 0x11FF) || (c >= 0x3000 && c <= 0x303F) ||
      (c >= 0x3040 && c <= 0x30FF) || (c >= 0x3130 && c <= 0x318F) ||
      (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0xAC00 && c <= 0xD7A3) ||
      (c >= 0xFF00 && c <= 0xFFEF);
  }
  function charW(ch, fontSize) { return isWideChar(ch) ? fontSize : fontSize * 0.58; }

  // text를 폭 maxWidth(px) 기준으로 최대 maxLines줄까지 줄바꿈한다. 다 담지 못하면 마지막
  // 줄을 말줄임(…) 처리해 폭 안에 맞춘다 — 박스 밖으로 텍스트가 새지 않게 하기 위함.
  // 순수·결정적(입력 문자열과 숫자만 본다).
  function fitLines(text, fontSize, maxWidth, maxLines) {
    var chars = Array.from(String(text == null ? '' : text));
    if (!chars.length) return [];
    var lines = [], i = 0;
    while (i < chars.length && lines.length < maxLines) {
      var cur = '', w = 0, j = i;
      while (j < chars.length) {
        var cw = charW(chars[j], fontSize);
        if (w + cw > maxWidth && cur) break;
        cur += chars[j]; w += cw; j++;
      }
      if (!cur) { cur = chars[j]; j++; } // 극단적으로 좁아 한 글자도 못 들어가면 강제로 1글자
      lines.push(cur);
      i = j;
    }
    if (i < chars.length) {
      var last = Array.from(lines[lines.length - 1]);
      var ew = charW('…', fontSize);
      var lw = 0; last.forEach(function (c) { lw += charW(c, fontSize); });
      while (last.length && lw + ew > maxWidth) { lw -= charW(last[last.length - 1], fontSize); last.pop(); }
      lines[lines.length - 1] = last.join('') + '…';
    }
    return lines;
  }

  var DEPT_COLORS = ['#2563eb','#d97706','#0d9488','#7c3aed','#16a34a','#db2777','#0891b2','#ca8a04'];
  function deptColor(dept) {
    var s = 0, d = String(dept || '');
    for (var i = 0; i < d.length; i++) s = (s * 31 + d.charCodeAt(i)) >>> 0;
    return DEPT_COLORS[s % DEPT_COLORS.length];
  }

  var TOP = 32, LEFT = 20;

  // 노드 박스 안 텍스트 레이아웃(요구사항: 박스 밖으로 안 새고, task는 최대 2줄+말줄임).
  // index.html의 .dag-t/.dag-d/.dag-b font-size와 반드시 맞춰야 한다.
  var TASK_FS = 15, DEPT_FS = 13, BOTT_FS = 12.5;
  var TEXT_X_PAD = 16, TEXT_R_PAD = 14;                 // 좌측 인디케이터바 + 여백 / 우측 여백
  var TASK_Y1 = 22, TASK_LINE_H = 19, DEPT_Y = 66, BOTT_Y1 = 90, BOTT_LINE_H = 15;

  // 폴리라인 P를 스무스 곡선(Catmull-Rom→cubic bezier)으로. 2점이면 수평 접선 곡선.
  function smoothPath(P) {
    function r(v) { return Math.round(v * 10) / 10; }
    if (P.length === 2) {
      var a = P[0], b = P[1], mx = (a.x + b.x) / 2;
      return 'M' + r(a.x) + ',' + r(a.y) + ' C' + r(mx) + ',' + r(a.y) + ' ' + r(mx) + ',' + r(b.y) + ' ' + r(b.x) + ',' + r(b.y);
    }
    var d = 'M' + r(P[0].x) + ',' + r(P[0].y);
    for (var i = 0; i < P.length - 1; i++) {
      var p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || P[i + 1];
      var c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      var c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      d += ' C' + r(c1x) + ',' + r(c1y) + ' ' + r(c2x) + ',' + r(c2y) + ' ' + r(p2.x) + ',' + r(p2.y);
    }
    return d;
  }

  // 세로(위→아래) 레이아웃 — graph.js가 이미 depth를 y(행)로, 같은 깊이 내 순서를 x(열)로
  // 계산해 주므로 여기서는 별도 좌표 변환 없이 n.x/n.y를 그대로 쓴다.
  function renderDag(g) {
  if (!g.nodes.length) return '';
  var W = G.NODE_W, H = G.NODE_H, GX = G.GAP_X;
  var maxD = 0, maxY = 0, maxX = 0;
  g.nodes.forEach(function(n){ if(n.depth>maxD)maxD=n.depth; if(n.y>maxY)maxY=n.y; if(n.x>maxX)maxX=n.x; });
  var w = maxX+W+40, h = TOP+maxY+H+24;
  var byId = {}; g.nodes.forEach(function(n){ byId[n.id]=n; });

  // width·height를 명시해 SVG를 고유 크기(=viewBox)로 렌더한다. CSS(.dag max-width:100%)가
  // 컨테이너보다 넓을 때만 줄이고, 좁을 땐 확대하지 않는다 — 항목이 적을 때 박스가 커지던 문제 방지.
  var out = '<svg viewBox="0 0 '+w+' '+h+'" width="'+w+'" height="'+h+'" class="dag" role="img" aria-label="진행 순서 및 우선순위 의존 그래프">';
  out += '<defs>'
      +  '<marker id="ah" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 z" fill="var(--line2)"/></marker>'
      +  '<marker id="ahc" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 z" fill="var(--chk)"/></marker>'
      +  '</defs>';

  // 행(단계) 라벨 — 각 깊이의 첫 노드 y 바로 위에 한 번씩만 그린다.
  var seenDepth = {};
  g.nodes.forEach(function(n){
    if (seenDepth[n.depth]) return;
    seenDepth[n.depth] = true;
    var ly = TOP + n.y - 12;
    out += '<text x="'+LEFT+'" y="'+ly+'" class="dag-col">'+(n.depth===0?'1단계 · 지금 시작 가능':(n.depth+1)+'단계')+'</text>';
  });

  // 엣지를 노드보다 먼저 그려 뒤에 깔리게 한다. graph.js가 준 route(포트·박스회피 웨이포인트)를 스플라인으로.
  g.edges.forEach(function(e){
    var route = e.route;
    if (!route || route.length < 2) return;
    var P = route.map(function(p){ return { x: LEFT + p.x, y: TOP + p.y }; });
    out += '<path d="'+ smoothPath(P) +'"'
        +  ' class="'+(e.critical?'dag-e crit':'dag-e')+'" marker-end="url(#'+(e.critical?'ahc':'ah')+')"/>';
  });

  // 노드
  var textMaxW = W - TEXT_X_PAD - TEXT_R_PAD;
  g.nodes.forEach(function(n){
    var x = LEFT+n.x, y = TOP+n.y;
    var taskLines = fitLines(n.task, TASK_FS, textMaxW, 2);
    var deptLines = fitLines(n.dept, DEPT_FS, textMaxW, 1);
    out += '<g class="dag-n'+(n.isBottleneck?' bott':'')+'" data-id="'+esc(n.id)+'" role="button" tabindex="0" aria-label="'+esc(n.task+' · '+n.dept)+'">'
        +  '<rect x="'+x+'" y="'+y+'" width="'+W+'" height="'+H+'" rx="8"/>'
        +  '<rect x="'+x+'" y="'+y+'" width="4" height="'+H+'" rx="2" fill="'+deptColor(n.dept)+'"/>'
        +  '<text class="dag-t">'+taskLines.map(function(ln,i){ return '<tspan x="'+(x+TEXT_X_PAD)+'" y="'+(y+TASK_Y1+i*TASK_LINE_H)+'">'+esc(ln)+'</tspan>'; }).join('')+'</text>'
        +  '<text class="dag-d">'+deptLines.map(function(ln){ return '<tspan x="'+(x+TEXT_X_PAD)+'" y="'+(y+DEPT_Y)+'">'+esc(ln)+'</tspan>'; }).join('')+'</text>';
    if (n.isBottleneck) {
      var bottLines = fitLines('⚠ '+n.downstream+'개 항목이 이 작업 완료를 기다리는 중', BOTT_FS, textMaxW, 2);
      out += '<text class="dag-b">'+bottLines.map(function(ln,i){ return '<tspan x="'+(x+TEXT_X_PAD)+'" y="'+(y+BOTT_Y1+i*BOTT_LINE_H)+'">'+esc(ln)+'</tspan>'; }).join('')+'</text>';
    }
    out += '</g>';
    // external 스텁 — 세로 흐름에서는 "먼저 완료돼야 할 항목"이므로 박스 위쪽에 나열한다.
    n.externals.forEach(function(lb, k){
      var sx = x + k*94, sy = y - 20;
      out += '<g class="dag-x"><rect x="'+sx+'" y="'+sy+'" width="88" height="14" rx="4"/>'
          +  '<text x="'+(sx+5)+'" y="'+(sy+10)+'">? '+esc(clip(lb,9))+'</text></g>';
    });
  });
  return out + '</svg>';
  }

  function renderDagWarnings(g) {
    // fuzzy는 현재 스키마(step+작업명 blocked_by)의 정상 경로다. 선행 표기를 자동 매칭하다
    // 일부를 못 찾았을 때(edgeTotal>edgeResolved)만 알린다. 전부 연결·의존 없음(0/0)이면 조용히.
    var partial = g.stats.mode === 'fuzzy' && g.stats.edgeTotal > g.stats.edgeResolved;
    if (!g.warnings.length && !partial) return '';
    var h = '<div class="dag-warn">';
    if (partial) {
      h += '<div class="w-row w-info">선행관계 일부만 자동 연결(' + g.stats.edgeTotal + '개 중 '
        + g.stats.edgeResolved + '개) — 나머지는 표기가 달라 매칭하지 못했습니다.</div>';
    }
    g.warnings.forEach(function (w) {
      if (w.type === 'cycle')       h += '<div class="w-row w-bad">순환 의존: ' + esc(w.detail) + '</div>';
      else if (w.type === 'empty')  h += '<div class="w-row w-info">진행 순서를 뽑을 수 없었습니다.</div>';
      else if (w.type === 'single') h += '<div class="w-row w-info">작업이 하나뿐이라 의존 관계가 없습니다.</div>';
      else if (w.type === 'unresolved' && g.stats.mode === 'id') h += '<div class="w-row w-info">' + esc(w.detail) + '</div>';
    });
    return h + '</div>';
  }

  // 상태 색상 role(지시#31): Green=완료, Amber=검토 필요, Gray=보조정보(추정) — index.html의 sc()와 동일 규칙.
  // Red(chk)는 상태 태그에서 더는 안 쓰고 지연·오류·필수조치(병목 강조 등) 전용으로 남겨 둔다.
  function statusClass(st) { return { '확정': 'ok', '추정': 'gray', '확인필요': 'est' }[st] || 'est'; }
  // 화면 표시용 상태 문구(내부 데이터값·비교 로직은 그대로 두고 라벨만 사용자 친화적으로 바꾼다).
  function statusLabel(st) { return { '확인필요': '검토 필요', '확정': '완료' }[st] || st; }
  // 지시#30: 상태를 색상 하나로만 구분하지 않고 아이콘을 함께 표기한다. index.html의 statusIcon()과 동일 규칙.
  function statusIcon(st) { return { '확정': '✓', '확인필요': '⚠', '추정': '~' }[st] || ''; }

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
      h += '<div class="np-bott">⚠ 지금 막혀있는 항목 · ' + node.downstream + '개 항목이 이 작업 완료를 기다리는 중</div>';
    }

    if (detail.matched) {
      h += '<dl class="np-facts">'
        + '<dt>담당</dt><dd>' + esc(detail.owner || '담당자 미정') + '</dd>'
        + '<dt>기한</dt><dd>' + esc(detail.due || '미정') + '</dd>'
        + '<dt>상태</dt><dd>' + (detail.status ? '<span class="tag ' + statusClass(detail.status) + '">' + (statusIcon(detail.status) ? esc(statusIcon(detail.status)) + ' ' : '') + esc(statusLabel(detail.status)) + '</span>' : '미정') + '</dd>'
        + '</dl>';
      if (detail.basis) h += '<div class="np-basis">↳ ' + esc(detail.basis) + '</div>';
    } else {
      h += '<div class="np-note">담당·기한·상태는 위 <b>부서별 실행 항목</b> 표에서 확인하세요.</div>';
    }

    if (preds.length) {
      h += '<div class="np-block"><div class="np-label">먼저 완료되어야 할 항목</div>'
        + preds.map(function (t) { return '<div class="np-dep">← ' + esc(t) + '</div>'; }).join('') + '</div>';
    }
    if (node.externals && node.externals.length) {
      h += '<div class="np-block"><div class="np-label">외부에서 먼저 완료되어야 할 항목 · 회의록에 없음</div>'
        + node.externals.map(function (x) { return '<div class="np-dep np-ext">? ' + esc(x) + '</div>'; }).join('') + '</div>';
    }
    return h;
  }

  var api = { renderDag: renderDag, renderDagWarnings: renderDagWarnings, deptColor: deptColor, nodePanelHtml: nodePanelHtml, fitLines: fitLines, statusLabel: statusLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DagView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
