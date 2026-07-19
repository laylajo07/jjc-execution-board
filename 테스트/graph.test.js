const test = require('node:test');
const assert = require('node:assert');
const { buildGraph } = require('../B_직접/앱/graph.js');

const node = (g, id) => g.nodes.find(n => n.id === id);

test('선행(blocked_by)에서 후행·깊이·병목을 파생한다', () => {
  const g = buildGraph([
    { id: 'T1', task: '재학습', dept: 'CB본부', blocked_by: [] },
    { id: 'T2', task: 'API 최적화', dept: 'ICT본부', blocked_by: ['T1'] },
    { id: 'T3', task: 'PoC 시연', dept: '사업솔루션본부', blocked_by: ['T2'] },
  ]);
  assert.equal(g.stats.mode, 'id');
  assert.equal(g.stats.edgeTotal, 2);
  assert.equal(g.stats.edgeResolved, 2);
  assert.equal(node(g, 'T1').depth, 0);
  assert.equal(node(g, 'T2').depth, 1);
  assert.equal(node(g, 'T3').depth, 2);
  assert.equal(node(g, 'T1').downstream, 2, 'T1은 T2·T3 둘을 막는다');
  assert.equal(node(g, 'T3').downstream, 0);
  assert.equal(node(g, 'T1').isBottleneck, true);
  assert.equal(node(g, 'T2').isBottleneck, false);
});

test('깊이는 최단이 아니라 최장 경로다 — 모든 선행보다 뒤에 놓인다', () => {
  // T1→T3, T1→T2→T3 : T3는 depth 1이 아니라 2여야 한다
  const g = buildGraph([
    { id: 'T1', task: 'a', dept: '', blocked_by: [] },
    { id: 'T2', task: 'b', dept: '', blocked_by: ['T1'] },
    { id: 'T3', task: 'c', dept: '', blocked_by: ['T1', 'T2'] },
  ]);
  assert.equal(node(g, 'T3').depth, 2);
});

test('병목 동점이면 둘 다 표시한다', () => {
  const g = buildGraph([
    { id: 'T1', task: 'a', dept: '', blocked_by: [] },
    { id: 'T2', task: 'b', dept: '', blocked_by: [] },
    { id: 'T3', task: 'c', dept: '', blocked_by: ['T1'] },
    { id: 'T4', task: 'd', dept: '', blocked_by: ['T2'] },
  ]);
  assert.equal(node(g, 'T1').isBottleneck, true);
  assert.equal(node(g, 'T2').isBottleneck, true);
});

test('병목에서 나가는 엣지만 critical이다', () => {
  const g = buildGraph([
    { id: 'T1', task: 'a', dept: '', blocked_by: [] },
    { id: 'T2', task: 'b', dept: '', blocked_by: ['T1'] },
    { id: 'T3', task: 'c', dept: '', blocked_by: ['T2'] },
  ]);
  assert.equal(g.edges.find(e => e.from === 'T1').critical, true);
  assert.equal(g.edges.find(e => e.from === 'T2').critical, false);
});

test('blocked_by_external은 엣지가 아니라 노드의 externals로 보존된다', () => {
  const g = buildGraph([
    { id: 'T1', task: 'a', dept: '', blocked_by: [], blocked_by_external: ['제품 스펙 확정'] },
  ]);
  assert.deepEqual(node(g, 'T1').externals, ['제품 스펙 확정']);
  assert.equal(g.edges.length, 0);
});

test('순환 의존을 탐지하고 경고한다 — 조용히 버리지 않는다', () => {
  const g = buildGraph([
    { id: 'T1', task: 'a', dept: '', blocked_by: ['T3'] },
    { id: 'T2', task: 'b', dept: '', blocked_by: ['T1'] },
    { id: 'T3', task: 'c', dept: '', blocked_by: ['T2'] },
  ]);
  const cyc = g.warnings.filter(w => w.type === 'cycle');
  assert.equal(cyc.length, 1, '순환 경고가 있어야 한다');
  assert.match(cyc[0].detail, /T1|T2|T3/);
  // back edge를 뺐으므로 레이아웃은 유한해야 한다
  assert.ok(g.nodes.every(n => Number.isFinite(n.depth)));
});

test('자기 자신을 선행으로 적으면 엣지가 되지 않는다', () => {
  const g = buildGraph([{ id: 'T1', task: 'a', dept: '', blocked_by: ['T1'] }]);
  assert.equal(g.edges.length, 0);
  assert.deepEqual(g.nodes[0].externals, ['T1']);
});

test('없는 id를 선행으로 적으면 external로 강등하고 경고한다', () => {
  const g = buildGraph([
    { id: 'T1', task: 'a', dept: '', blocked_by: ['없는거'] },
  ]);
  assert.equal(g.edges.length, 0);
  assert.deepEqual(g.nodes[0].externals, ['없는거']);
  assert.equal(g.stats.edgeTotal, 1);
  assert.equal(g.stats.edgeResolved, 0);
  assert.ok(g.warnings.some(w => w.type === 'unresolved'));
});

test('빈 입력', () => {
  const g = buildGraph([]);
  assert.deepEqual(g.nodes, []);
  assert.ok(g.warnings.some(w => w.type === 'empty'));
});

test('노드 1개면 single 경고 — 다이어그램 대신 한 줄로 표시하게 한다', () => {
  const g = buildGraph([{ id: 'T1', task: 'a', dept: '', blocked_by: [] }]);
  assert.ok(g.warnings.some(w => w.type === 'single'));
});

test('id가 없으면 배열 순서로 T1..Tn을 자동 부여한다', () => {
  const g = buildGraph([
    { task: 'a', dept: '', blocked_by: [] },
    { task: 'b', dept: '', blocked_by: [] },
  ]);
  assert.deepEqual(g.nodes.map(n => n.id), ['T1', 'T2']);
});

const fs = require('node:fs');
const path = require('node:path');

test('구버전(id 없음) 데이터는 fuzzy 모드로 떨어진다', () => {
  const g = buildGraph([
    { task: 'v2 모델 재학습 → AUC 0.85 달성', dept: 'CB본부', blocked_by: [] },
    { task: 'API 응답속도 최적화·배포', dept: 'ICT본부', blocked_by: ['v2 모델 확정'] },
  ]);
  assert.equal(g.stats.mode, 'fuzzy');
  assert.equal(g.stats.edgeResolved, 1, '짧은 별칭이 긴 정식명칭에 붙어야 한다');
  assert.equal(g.edges[0].from, 'T1');
  assert.equal(g.edges[0].to, 'T2');
});

test('접미 차이만 있는 것은 붙는다', () => {
  const g = buildGraph([
    { task: '가격 단가표 초안 작성', dept: '', blocked_by: [] },
    { task: '가격정책 확정', dept: '', blocked_by: ['가격 단가표 초안'] },
  ]);
  assert.equal(g.stats.edgeResolved, 1);
});

test('대응 노드가 없으면 external로 두고 지어내지 않는다', () => {
  const g = buildGraph([
    { task: 'v2 모델 재학습 → AUC 0.85 달성', dept: '', blocked_by: [] },
    { task: '마케팅 브로셔·랜딩 제작', dept: '', blocked_by: ['제품 스펙 확정'] },
  ]);
  assert.equal(g.stats.edgeResolved, 0);
  assert.deepEqual(g.nodes[1].externals, ['제품 스펙 확정']);
});

test('실제 구버전 샘플01 파일이 크래시 없이 처리되고 성능 저하가 stats에 드러난다', () => {
  const p = path.join(__dirname, '..', 'B_직접', '앱', '결과', '샘플01_결과.json');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const g = buildGraph(d.sequence);
  assert.equal(g.stats.mode, 'fuzzy');
  assert.equal(g.stats.edgeTotal, 8, '구버전 샘플01의 선행은 8개');
  assert.ok(g.stats.edgeResolved < g.stats.edgeTotal, 'fuzzy는 완전 복구가 아니다');
  assert.ok(g.warnings.some(w => w.type === 'unresolved'), '몇 개가 안 붙었는지 반드시 알려야 한다');
});

const { NODE_W, GAP_X } = require('../B_직접/앱/graph.js');

test('좌표: x는 깊이에 비례하고, 같은 열은 y가 겹치지 않는다', () => {
  const g = buildGraph([
    { id: 'T1', task: 'a', dept: '', blocked_by: [] },
    { id: 'T2', task: 'b', dept: '', blocked_by: [] },
    { id: 'T3', task: 'c', dept: '', blocked_by: ['T1'] },
  ]);
  assert.equal(node(g, 'T1').x, 0);
  assert.equal(node(g, 'T3').x, NODE_W + GAP_X);
  assert.notEqual(node(g, 'T1').y, node(g, 'T2').y, '같은 열의 두 노드는 y가 달라야 한다');
});

test('좌표는 결정적이다 — 같은 입력이면 같은 출력', () => {
  const input = [
    { id: 'T1', task: 'a', dept: '', blocked_by: [] },
    { id: 'T2', task: 'b', dept: '', blocked_by: ['T1'] },
    { id: 'T3', task: 'c', dept: '', blocked_by: ['T1'] },
  ];
  const a = buildGraph(JSON.parse(JSON.stringify(input)));
  const b = buildGraph(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(a.nodes.map(n => [n.id, n.x, n.y]), b.nodes.map(n => [n.id, n.x, n.y]));
});

// ★ 설계 8절의 인수 기준
test('[인수] 샘플01 신스키마: 엣지 8/8 · 병목 = v2 재학습 · 후행 4', () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', '샘플01_신스키마.json'), 'utf8'));
  const g = buildGraph(d.sequence);

  assert.equal(g.stats.mode, 'id');
  assert.equal(g.stats.edgeTotal, 8);
  assert.equal(g.stats.edgeResolved, 8, '신스키마는 선행이 전부 연결되어야 한다');
  assert.equal(g.warnings.filter(w => w.type === 'unresolved').length, 0);
  assert.equal(g.warnings.filter(w => w.type === 'cycle').length, 0);

  const bn = g.nodes.filter(n => n.isBottleneck);
  assert.equal(bn.length, 1);
  assert.equal(bn[0].id, 'T2');
  assert.equal(bn[0].task, 'v2 모델 재학습 → AUC 0.85 달성');
  assert.equal(bn[0].downstream, 4, 'T5·T6·T7·T8 넷을 막는다');

  // 끊긴 선행은 지어내지 않고 external로 보존
  assert.deepEqual(node(g, 'T9').externals, ['제품 스펙 확정']);
});

test('A·B의 graph.js는 바이트 단위로 동일해야 한다 (복사 누락 방지)', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', 'A_웹페이지', '앱', 'graph.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'B_직접', '앱', 'graph.js'), 'utf8');
  assert.equal(a, b, 'A와 B의 graph.js가 다릅니다 — 한쪽만 고쳤습니다');
});

const { renderDag, renderDagWarnings } = require('../B_직접/앱/dag-view.js');

test('DAG SVG: 병목 노드에 후행 개수 배지가 붙는다', () => {
  const g = buildGraph([
    { id: 'T1', task: '재학습', dept: 'CB본부', blocked_by: [] },
    { id: 'T2', task: 'API', dept: 'ICT본부', blocked_by: ['T1'] },
    { id: 'T3', task: 'PoC', dept: '사업솔루션본부', blocked_by: ['T2'] },
  ]);
  const svg = renderDag(g);
  assert.match(svg, /^<svg /);
  assert.match(svg, /후행 2개가 이걸 기다림/);
});

test('병목에서 나가는 엣지만 crit 클래스를 갖는다', () => {
  const g = buildGraph([
    { id: 'T1', task: 'a', dept: '', blocked_by: [] },
    { id: 'T2', task: 'b', dept: '', blocked_by: ['T1'] },
    { id: 'T3', task: 'c', dept: '', blocked_by: ['T2'] },
  ]);
  const svg = renderDag(g);
  assert.equal((svg.match(/class="dag-e crit"/g) || []).length, 1);
  assert.equal((svg.match(/class="dag-e"/g) || []).length, 1);
});

test('external 선행은 점선 스텁으로 그려진다', () => {
  const g = buildGraph([
    { id: 'T1', task: 'a', dept: '', blocked_by: [], blocked_by_external: ['제품 스펙 확정'] },
  ]);
  assert.match(renderDag(g), /dag-x/);
  assert.match(renderDag(g), /제품 스펙/);
});

test('XSS: 회의록에서 온 문자열은 이스케이프된다', () => {
  const g = buildGraph([
    { id: 'T1', task: '<script>alert(1)</script>', dept: '"><img>', blocked_by: [] },
  ]);
  const svg = renderDag(g);
  assert.ok(!svg.includes('<script>'), '스크립트 태그가 그대로 들어가면 안 된다');
  assert.match(svg, /&lt;script&gt;/);
});

test('fuzzy 모드면 몇 개가 연결됐는지 고지한다', () => {
  const g = buildGraph([
    { task: 'v2 모델 재학습 → AUC 0.85 달성', dept: '', blocked_by: [] },
    { task: 'x', dept: '', blocked_by: ['전혀 다른 것'] },
  ]);
  const w = renderDagWarnings(g);
  assert.match(w, /구버전 결과/);
  assert.match(w, /1개 중 0개만 연결/);
});

test('순환 경고는 화면에 노출된다', () => {
  const g = buildGraph([
    { id: 'T1', task: 'a', dept: '', blocked_by: ['T2'] },
    { id: 'T2', task: 'b', dept: '', blocked_by: ['T1'] },
  ]);
  assert.match(renderDagWarnings(g), /순환 의존/);
});

test('renderDag: 각 노드 <g>에 data-id·role·tabindex가 붙는다 (클릭·키보드 타깃)', () => {
  const g = buildGraph([
    { id: 'T1', task: '재학습', dept: 'CB본부', blocked_by: [] },
    { id: 'T2', task: 'API', dept: 'ICT본부', blocked_by: ['T1'] },
  ]);
  const svg = renderDag(g);
  assert.match(svg, /data-id="T1"/);
  assert.match(svg, /data-id="T2"/);
  assert.match(svg, /role="button"/);
  assert.match(svg, /tabindex="0"/);
  assert.match(svg, /aria-label="재학습 · CB본부"/);
});

test('A·B의 dag-view.js는 바이트 단위로 동일해야 한다', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', 'A_웹페이지', '앱', 'dag-view.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'B_직접', '앱', 'dag-view.js'), 'utf8');
  assert.equal(a, b, 'A와 B의 dag-view.js가 다릅니다 — 한쪽만 고쳤습니다');
});

const { normalize, containment } = require('../B_직접/앱/graph.js');

test('graph.js가 normalize·containment를 노출한다 (board-derive 재사용용)', () => {
  assert.equal(typeof normalize, 'function');
  assert.equal(typeof containment, 'function');
  // 괄호·특수문자 제거 후 짧은 정식명칭이 긴 노드명에 포함 → 높은 포함계수
  assert.ok(
    containment('피처 추가 후 v2 모델 재학습 (AUC 0.85 목표)', 'v2 모델 재학습 → AUC 0.85 달성') >= 0.5,
    '실측 0.85 근처여야 한다'
  );
});

const { buildDetailMap, rankItems } = require('../B_직접/앱/board-derive.js');

test('buildDetailMap: 노드 task를 action_item(what)에 조인해 담당/기한/상태를 붙인다', () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', '샘플01_신스키마.json'), 'utf8'));
  const g = buildGraph(d.sequence);
  const byDept = [
    { dept: 'CB본부', action_items: [
      { what: '피처 추가 후 v2 모델 재학습 (AUC 0.85 목표, 현재 0.82)', owner: '박리드', due: '확인 필요', status: '확인필요', basis: '' },
    ] },
  ];
  const map = buildDetailMap(g, byDept);
  assert.equal(map['T2'].matched, true, 'v2 재학습 노드가 조인되어야 한다');
  assert.equal(map['T2'].owner, '박리드');
  assert.equal(map['T2'].status, '확인필요');
  assert.equal(map['T9'].matched, false, '대응 action_item이 없는 노드는 matched:false');
});

test('[인수] rankItems: 병목에 걸린 gap이 1위, 무관한 별건 gap이 꼴찌', () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', '샘플01_신스키마.json'), 'utf8'));
  const g = buildGraph(d.sequence); // 병목 = T2(v2 재학습), downstream 4
  const gaps = [
    '데사팀 채용 1명은 별건으로 보류',      // 미매칭 → cpScore 0
    'v2 모델 재학습 완료 기한 미기재',        // T2 병목 → cpScore 2 (실측 0.46, RANK_THRESH 0.35로 매칭)
    'API 응답속도 최적화 기한 미기재',        // T5 → cpScore 1
  ];
  const ranked = rankItems(g, gaps).map(r => r.text);
  assert.equal(ranked[0], 'v2 모델 재학습 완료 기한 미기재', '병목 gap이 최상위');
  assert.equal(ranked[ranked.length - 1], '데사팀 채용 1명은 별건으로 보류', '미매칭 별건이 꼴찌');
});

test('rankItems: 외부 스텁(제품 스펙 확정)을 가리키는 gap은 cpScore 1', () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', '샘플01_신스키마.json'), 'utf8'));
  const g = buildGraph(d.sequence);
  const ranked = rankItems(g, ['제품 스펙 확정 시점 미정', '데사팀 별건 보류']);
  const ext = ranked.find(r => r.text.indexOf('제품 스펙') === 0);
  assert.equal(ext.cpScore, 1, '외부 선행 매칭 → 준-critical');
});

test('rankItems: 빈 입력은 빈 배열', () => {
  const g = buildGraph([{ id: 'T1', task: 'a', dept: '', blocked_by: [] }]);
  assert.deepEqual(rankItems(g, []), []);
  assert.deepEqual(rankItems(g, null), []);
});

test('A·B의 board-derive.js는 바이트 단위로 동일해야 한다 (복사 누락 방지)', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', 'A_웹페이지', '앱', 'board-derive.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'B_직접', '앱', 'board-derive.js'), 'utf8');
  assert.equal(a, b, 'A와 B의 board-derive.js가 다릅니다 — 한쪽만 고쳤습니다');
});
