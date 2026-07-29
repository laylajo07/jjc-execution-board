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

test('step 스키마: blocked_by가 단계 번호면 step으로 정확 매칭돼 깊은 체인이 살아난다', () => {
  // 모델이 blocked_by를 작업명이 아니라 단계 번호([1],[2]…)로 참조하는 경우 — 4단계 체인.
  const g = buildGraph([
    { step: 1, task: '결합 서비스 적법성 법률 검토', dept: '법무실', blocked_by: [] },
    { step: 2, task: '등급 암시 금지 가이드라인 수립', dept: '법무실', blocked_by: [1] },
    { step: 3, task: '알림 문구 초안 작성', dept: '마케팅', blocked_by: [2] },
    { step: 4, task: '발송 로직 개발', dept: 'ICT본부', blocked_by: ['3'] },  // 문자열 숫자도 허용
  ]);
  assert.equal(g.stats.mode, 'fuzzy');
  assert.equal(g.stats.edgeTotal, 3);
  assert.equal(g.stats.edgeResolved, 3, '숫자 blocked_by가 step으로 전부 해결돼야 한다');
  assert.equal(node(g, 'T4').depth, 3, '4단계 체인이면 최대 깊이 3');
});

test('숫자 blocked_by라도 그 step이 없으면 지어내지 않고 external로 둔다', () => {
  const g = buildGraph([
    { step: 1, task: 'A 작업', dept: '', blocked_by: [] },
    { step: 2, task: 'B 작업', dept: '', blocked_by: [9] },  // step 9는 없음
  ]);
  assert.equal(g.stats.edgeResolved, 0);
  assert.deepEqual(g.nodes[1].externals, ['9']);
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

test('좌표(세로 레이아웃): y는 깊이에 비례하고, 같은 행은 x가 겹치지 않는다', () => {
  const g = buildGraph([
    { id: 'T1', task: 'a', dept: '', blocked_by: [] },
    { id: 'T2', task: 'b', dept: '', blocked_by: [] },
    { id: 'T3', task: 'c', dept: '', blocked_by: ['T1'] },
  ]);
  assert.equal(node(g, 'T1').y, 0);
  assert.equal(node(g, 'T3').y, NODE_H + GAP_X);
  assert.notEqual(node(g, 'T1').x, node(g, 'T2').x, '같은 행의 두 노드는 x가 달라야 한다');
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
  // 병목 문구는 박스 폭에 맞춰 2줄(tspan 2개)로 나뉘어 그려진다 — 줄바꿈 지점 앞뒤로 나눠 확인.
  assert.match(svg, /class="dag-b"/);
  assert.match(svg, /⚠ 2개 항목이 이 작업 완료를 기/);
  assert.match(svg, /다리는 중/);
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

test('fuzzy 모드에서 선행 일부가 매칭 안 되면 몇 개 연결됐는지 고지한다 (구버전·재분석 문구 없이)', () => {
  const g = buildGraph([
    { task: 'v2 모델 재학습 → AUC 0.85 달성', dept: '', blocked_by: [] },
    { task: 'x', dept: '', blocked_by: ['전혀 다른 것'] },
  ]);
  const w = renderDagWarnings(g);
  assert.match(w, /일부만 자동 연결/);
  assert.match(w, /1개 중 0개/);
  assert.doesNotMatch(w, /구버전/, '현재 스키마 결과를 "구버전"으로 오인시키면 안 된다');
  assert.doesNotMatch(w, /다시 분석/, '재분석하라는 오해 소지 문구를 넣으면 안 된다');
});

test('fuzzy 모드라도 선행관계가 전부 연결되면(0개 중 0개 포함) 경고를 띄우지 않는다', () => {
  // 회의에 선후행이 전혀 없는 흔한 경우(step 스키마) — 예전엔 "0개 중 0개만 연결됨"이 항상 떴다.
  const g = buildGraph([
    { step: 1, task: 'KPI 취합', dept: '경영본부', blocked_by: [] },
    { step: 2, task: '오류시트 수정', dept: 'ICT본부', blocked_by: [] },
  ]);
  assert.equal(g.stats.mode, 'fuzzy');
  assert.equal(g.stats.edgeTotal, 0);
  assert.equal(g.stats.edgeResolved, 0);
  assert.equal(renderDagWarnings(g), '', '의존관계 0/0이면 경고 박스를 만들지 않는다');
});

test('renderDag: SVG에 viewBox와 일치하는 명시적 width·height가 붙는다 (컨테이너에서 확대 방지)', () => {
  const g = buildGraph([
    { id: 'T1', task: 'a', dept: '', blocked_by: [] },
    { id: 'T2', task: 'b', dept: '', blocked_by: [] },
  ]);
  const svg = renderDag(g);
  const vb = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  assert.ok(vb, 'viewBox가 있어야 한다');
  assert.match(svg, new RegExp('\\swidth="' + vb[1] + '"'), 'width 속성이 viewBox 너비와 일치해야 한다');
  assert.match(svg, new RegExp('\\sheight="' + vb[2] + '"'), 'height 속성이 viewBox 높이와 일치해야 한다');
});

test('fuzzy 모드에서 선행이 전부 연결돼도(partial=false) 순환 같은 실제 경고는 계속 노출된다', () => {
  // partial 아님(2/2 연결)이지만 순환이 있는 경우 — 경고 박스를 억제하면 안 된다.
  const g = buildGraph([
    { task: '데이터 정제', dept: '', blocked_by: ['모델 학습'] },
    { task: '모델 학습', dept: '', blocked_by: ['데이터 정제'] },
  ]);
  assert.equal(g.stats.mode, 'fuzzy');
  assert.equal(g.stats.edgeTotal, g.stats.edgeResolved, '이 케이스는 partial이 아니어야 한다(전부 연결)');
  assert.match(renderDagWarnings(g), /순환 의존/, 'partial이 아니어도 순환 경고는 보여야 한다');
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

// ── fitLines: 박스 폭 기준 줄바꿈·말줄임 (크리티컬 패스 박스 텍스트 오버플로 수정) ──────
const { fitLines } = require('../B_직접/앱/dag-view.js');
const WIDE_RE = /[ᄀ-ᇿ　-〿぀-ヿ㄰-㆏一-鿿가-힣＀-￯]/;
function estWidth(line, fontSize) {
  return Array.from(line).reduce((sum, ch) => sum + (WIDE_RE.test(ch) ? fontSize : fontSize * 0.58), 0);
}

test('fitLines: 폭 안에 들어가는 짧은 텍스트는 1줄, 말줄임 없다', () => {
  const lines = fitLines('짧은제목', 13.5, 144, 2);
  assert.deepEqual(lines, ['짧은제목']);
});

test('fitLines: 2줄에 걸치는 텍스트는 잘림 없이 2줄로 나뉘고 말줄임이 없다', () => {
  const text = '가'.repeat(20);
  const lines = fitLines(text, 13.5, 144, 2);
  assert.equal(lines.length, 2);
  assert.ok(!lines[lines.length - 1].endsWith('…'));
  assert.equal(lines.join(''), text, '분해해도 원래 글자가 전부 보존돼야 한다(잘림 없이)');
});

test('fitLines: maxLines를 넘는 텍스트는 마지막 줄에 말줄임(…)을 붙이고, 어떤 줄도 폭을 넘지 않는다', () => {
  const text = '가'.repeat(40);
  const lines = fitLines(text, 13.5, 144, 2);
  assert.equal(lines.length, 2, '최대 2줄까지만');
  assert.ok(lines[1].endsWith('…'), '초과 시 마지막 줄이 말줄임 처리돼야 한다');
  lines.forEach(ln => {
    assert.ok(estWidth(ln, 13.5) <= 144 + 0.01, `줄 "${ln}"이 박스 폭(144)을 넘으면 안 된다(요구사항: 박스 밖으로 안 샘)`);
  });
});

test('fitLines: 빈 텍스트·null은 빈 배열', () => {
  assert.deepEqual(fitLines('', 13.5, 144, 2), []);
  assert.deepEqual(fitLines(null, 13.5, 144, 2), []);
  assert.deepEqual(fitLines(undefined, 13.5, 144, 2), []);
});

test('fitLines: maxLines=1이면 아무리 길어도 1줄 이하(부서명 등 단일행 필드용)', () => {
  const lines = fitLines('아주 긴 부서명(팀·본부·소속 표기 다 포함해서 상당히 길게)', 12, 144, 1);
  assert.ok(lines.length <= 1);
  if (lines.length) assert.ok(estWidth(lines[0], 12) <= 144 + 0.01);
});

test('renderDag: 매우 긴 task는 박스 안에서 최대 2줄(tspan 2개)까지만 표시되고, 넘치면 말줄임 처리된다', () => {
  const g = buildGraph([
    { id: 'T1', task: '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허그느드르므브스으즈츠크트프흐', dept: 'ICT본부', blocked_by: [] },
  ]);
  const svg = renderDag(g);
  const m = svg.match(/<text class="dag-t">([\s\S]*?)<\/text>/);
  assert.ok(m, 'dag-t 텍스트 요소가 있어야 한다');
  const tspanCount = (m[1].match(/<tspan/g) || []).length;
  assert.ok(tspanCount <= 2, '최대 2줄(tspan 2개 이하)이어야 한다 — 실제 ' + tspanCount);
  assert.match(m[1], /…<\/tspan>/, '넘치는 텍스트는 말줄임(…) 처리돼야 한다');
});

test('renderDag: 짧은 task는 1줄(tspan 1개)로 표시되고 말줄임이 없다', () => {
  const g = buildGraph([{ id: 'T1', task: '짧은작업', dept: 'ICT본부', blocked_by: [] }]);
  const svg = renderDag(g);
  const m = svg.match(/<text class="dag-t">([\s\S]*?)<\/text>/);
  const tspanCount = (m[1].match(/<tspan/g) || []).length;
  assert.equal(tspanCount, 1);
  assert.doesNotMatch(m[1], /…/);
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

test('buildDetailMap: 같은 부서명이 없으면 전체 풀에서 조인한다(global fallback)', () => {
  const g = buildGraph([{ id: 'T1', task: 'v2 모델 재학습', dept: 'CB본부', blocked_by: [] }]);
  const byDept = [ { dept: '씨비본부', action_items: [ { what: '피처 추가 후 v2 모델 재학습 (AUC 0.85 목표)', owner: '박리드', due: '', status: '확인필요' } ] } ];
  const map = buildDetailMap(g, byDept);
  assert.equal(map['T1'].matched, true, '부서명이 안 맞아도 전체 풀에서 매칭되어야 한다');
  assert.equal(map['T1'].owner, '박리드');
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

// ── qualityScore (지시사항 14: 회의록 품질 점수) ──
const { qualityScore, friendlyTitle } = require('../B_직접/앱/board-derive.js');

test('qualityScore: 담당·기한·의사결정이 전부 채워진 보드는 100점, missing 0', () => {
  const board = { by_department: [
    { dept: 'CB본부',
      action_items: [{ what: 'a', owner: '철수', due: '7/10', status: '확정' }],
      documents: [{ doc: 'd', owner: '영희', due: '7/11', status: '확정' }],
      decisions_needed: [{ topic: 't', decider: '민수', due: '7/12', status: '확정' }],
    },
  ] };
  const qs = qualityScore(board);
  assert.equal(qs.score, 100);
  assert.equal(qs.ownerMissing, 0);
  assert.equal(qs.dueMissing, 0);
  assert.equal(qs.decisionOpen, 0);
  assert.equal(qs.itemCount, 2, 'action_item 1 + document 1');
  assert.equal(qs.decisionCount, 1);
  assert.equal(qs.total, 7, 'ownerSlots3+dueSlots3+decisionSlots1');
});

test('qualityScore: 절반이 미정이면 대략 그 비율의 점수가 나온다', () => {
  const board = { by_department: [
    { dept: 'X',
      action_items: [
        { what: 'a', owner: '미정', due: '7/10' },   // owner 미정
        { what: 'b', owner: '미정', due: '7/11' },   // owner 미정
        { what: 'c', owner: '철수', due: '미정' },   // due 미정
        { what: 'd', owner: '영희', due: '미정' },   // due 미정
      ],
      documents: [], decisions_needed: [],
    },
  ] };
  const qs = qualityScore(board);
  // items=4 → ownerSlots4+dueSlots4+decisionSlots0=total8, missing=2+2=4 → 50점
  assert.equal(qs.total, 8);
  assert.equal(qs.ownerMissing, 2);
  assert.equal(qs.dueMissing, 2);
  assert.equal(qs.score, 50);
});

test('qualityScore: decisions_needed 상태 확정 vs 확인필요가 decisionOpen에 반영된다', () => {
  const board = { by_department: [
    { dept: 'X', action_items: [], documents: [],
      decisions_needed: [
        { topic: 't1', decider: '민수', due: '7/1', status: '확정' },
        { topic: 't2', decider: '지수', due: '7/2', status: '확인필요' },
      ],
    },
  ] };
  const qs = qualityScore(board);
  assert.equal(qs.decisionCount, 2);
  assert.equal(qs.decisionOpen, 1, '확정이 아닌 것만 미완');
  // total = ownerSlots2+dueSlots2+decisionSlots2 = 6, missing = decisionOpen 1 → round((1-1/6)*100)=83
  assert.equal(qs.total, 6);
  assert.equal(qs.score, 83);
});

test('qualityScore: "미정" 판정은 빈값·미정·미상·[미상]·- 를 trim 후 모두 잡는다', () => {
  const board = { by_department: [
    { dept: 'X',
      action_items: [
        { what: 'a', owner: '', due: '7/1' },
        { what: 'b', owner: '미정', due: '7/1' },
        { what: 'c', owner: '미상', due: '7/1' },
        { what: 'd', owner: '[미상]', due: '7/1' },
        { what: 'e', owner: '-', due: '7/1' },
        { what: 'f', owner: '  미정  ', due: '7/1' },
        { what: 'g', owner: '철수', due: '7/1' },   // 이건 채워짐 — 미정 아님
      ],
      documents: [], decisions_needed: [],
    },
  ] };
  const qs = qualityScore(board);
  assert.equal(qs.ownerMissing, 6, '앞의 6개만 미정으로 잡히고 마지막(철수)은 아니어야 한다');
  assert.equal(qs.dueMissing, 0);
});

test('qualityScore: "예시" 목표일은 확정 기한이 아니므로 dueMissing에 포함된다', () => {
  const board = { by_department: [
    { dept: 'X',
      action_items: [
        { what: 'a', owner: '철수', due: '예시 2026-08-04' },   // 예시 → 미확정
        { what: 'b', owner: '영희', due: '2026-08-04' },        // 확정 날짜 → 미확정 아님
        { what: 'c', owner: '민수', due: '미정' },              // 빈값 → 미확정
      ],
      documents: [], decisions_needed: [
        { topic: 't', decider: '대표', due: '(예시) 2026-08-11', status: '확정' },  // 예시 → 미확정
      ],
    },
  ] };
  const qs = qualityScore(board);
  assert.equal(qs.dueMissing, 3, '예시 2건 + 미정 1건 = 3, 실제 날짜만 확정으로 인정');
});

test('qualityScore: 빈 보드/null은 예외 없이 score 100, 모든 카운트 0', () => {
  assert.deepEqual(qualityScore(null), { score: 100, ownerMissing: 0, dueMissing: 0, decisionOpen: 0, itemCount: 0, decisionCount: 0, total: 0 });
  assert.deepEqual(qualityScore(undefined), { score: 100, ownerMissing: 0, dueMissing: 0, decisionOpen: 0, itemCount: 0, decisionCount: 0, total: 0 });
  assert.deepEqual(qualityScore({}), { score: 100, ownerMissing: 0, dueMissing: 0, decisionOpen: 0, itemCount: 0, decisionCount: 0, total: 0 });
  assert.deepEqual(qualityScore({ by_department: [] }), { score: 100, ownerMissing: 0, dueMissing: 0, decisionOpen: 0, itemCount: 0, decisionCount: 0, total: 0 });
});

test('qualityScore: 이상한/기형 board가 와도 절대 예외를 던지지 않는다', () => {
  assert.doesNotThrow(() => qualityScore('문자열'));
  assert.doesNotThrow(() => qualityScore(42));
  assert.doesNotThrow(() => qualityScore({ by_department: '배열아님' }));
  assert.doesNotThrow(() => qualityScore({ by_department: [{ action_items: null, documents: undefined, decisions_needed: 5 }] }));
  const qs = qualityScore({ by_department: [{ action_items: null, documents: undefined, decisions_needed: 5 }] });
  assert.equal(qs.total, 0, '슬롯을 못 세는 기형 필드는 무시하고 0으로 떨어져야 한다');
});

test('qualityScore: 불변 — 입력 board를 변형하지 않는다', () => {
  const board = { by_department: [
    { dept: 'X', action_items: [{ what: 'a', owner: '', due: '' }], documents: [], decisions_needed: [] },
  ] };
  const snapshot = JSON.parse(JSON.stringify(board));
  qualityScore(board);
  assert.deepEqual(board, snapshot);
});

// ── friendlyTitle (사용자 친화 타이틀) ──
test('friendlyTitle: meeting.title을 그대로 쓴다(짧은 제목)', () => {
  assert.equal(friendlyTitle({ meeting: { title: '신용평가 등급 알림 서비스 기획 회의' } }), '신용평가 등급 알림 서비스 기획 회의');
});

test('friendlyTitle: 앞머리 날짜 접두([2026-07-21] 등)를 떼어낸다', () => {
  assert.equal(friendlyTitle({ meeting: { title: '[2026-07-21] 신용평가 알림 회의' } }), '신용평가 알림 회의');
  assert.equal(friendlyTitle({ meeting: { title: '2026.07.21 킥오프' } }), '킥오프');
});

test('friendlyTitle: 34자를 넘으면 잘라 …를 붙인다', () => {
  const longTitle = '가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하';
  const out = friendlyTitle({ meeting: { title: longTitle } });
  assert.ok(out.length <= 36, '대략 34자+… 이내');
  assert.ok(out.endsWith('…'), '말줄임표로 끝난다');
});

test('friendlyTitle: 제목이 없으면 headline으로, 그것도 없으면 기본값', () => {
  assert.equal(friendlyTitle({ meeting: {}, headline: '짧은 요약' }), '짧은 요약');
  assert.equal(friendlyTitle({ meeting: { title: '[미상]' }, headline: '' }), '회의 실행보드');
  assert.equal(friendlyTitle({}), '회의 실행보드');
  assert.equal(friendlyTitle(null), '회의 실행보드');
});

const { nodePanelHtml } = require('../B_직접/앱/dag-view.js');

test('nodePanelHtml: 매칭 상세는 담당/기한/상태를 담고, 병목은 후행 수를 담는다', () => {
  const g = buildGraph([
    { id: 'T1', task: 'v2 재학습', dept: 'CB본부', blocked_by: [] },
    { id: 'T2', task: 'API', dept: 'ICT본부', blocked_by: ['T1'] },
  ]);
  const n = g.nodes.find(x => x.id === 'T1'); // 병목, 후행 1
  const html = nodePanelHtml(n, { matched: true, owner: '박리드', due: '7/15', status: '확인필요', basis: '' }, g);
  assert.match(html, /박리드/);
  assert.match(html, /7\/15/);
  assert.match(html, /<span class="tag chk">검토 필요<\/span>/);
  assert.match(html, /1개 항목이 이 작업 완료를 기다리는 중/);
});

test('nodePanelHtml: 미매칭이면 부서 표 참조 안내로 축약한다', () => {
  const g = buildGraph([{ id: 'T1', task: 'a', dept: 'X', blocked_by: [] }]);
  const html = nodePanelHtml(g.nodes[0], { matched: false }, g);
  assert.match(html, /부서별 실행 항목/);
});

test('nodePanelHtml: 외부 선행을 나열하고 회의록 문자열을 이스케이프한다', () => {
  const g = buildGraph([
    { id: 'T1', task: '<b>x</b>', dept: '', blocked_by: [], blocked_by_external: ['제품 스펙 확정'] },
  ]);
  const html = nodePanelHtml(g.nodes[0], { matched: false }, g);
  assert.match(html, /제품 스펙 확정/);
  assert.ok(!html.includes('<b>x</b>'), '작업명이 그대로 들어가면 안 된다');
  assert.match(html, /&lt;b&gt;/);
});

const { NODE_H } = require('../B_직접/앱/graph.js');

test('레이아웃(세로): 엣지마다 route(소스 하변 포트 → 타깃 상변 포트)가 붙는다', () => {
  const g = buildGraph([
    { id: 'T1', task: 'a', dept: '', blocked_by: [] },
    { id: 'T2', task: 'b', dept: '', blocked_by: ['T1'] },
  ]);
  const e = g.edges[0], a = node(g, 'T1'), b = node(g, 'T2');
  assert.ok(Array.isArray(e.route) && e.route.length >= 2);
  assert.equal(e.route[0].y, a.y + NODE_H, '시작은 소스 노드 하변');
  assert.equal(e.route[e.route.length - 1].y, b.y, '끝은 타깃 노드 상변');
  assert.ok(e.route[0].x > a.x && e.route[0].x < a.x + NODE_W, '포트는 노드 가로 범위 안');
});

test('레이아웃(세로): 포트 분산 — 한 노드의 여러 나가는 엣지는 시작 x가 서로 다르다', () => {
  const g = buildGraph([
    { id: 'T1', task: 'a', dept: '', blocked_by: [] },
    { id: 'T2', task: 'b', dept: '', blocked_by: ['T1'] },
    { id: 'T3', task: 'c', dept: '', blocked_by: ['T1'] },
  ]);
  const e2 = g.edges.find(e => e.to === 'T2'), e3 = g.edges.find(e => e.to === 'T3');
  assert.notEqual(e2.route[0].x, e3.route[0].x, 'T1의 두 나가는 엣지 포트가 분산돼야 한다');
});

test('레이아웃: 다열을 건너뛰는 엣지는 중간 열 통과 웨이포인트가 생긴다', () => {
  const g = buildGraph([
    { id: 'T1', task: 'a', dept: '', blocked_by: [] },
    { id: 'T2', task: 'b', dept: '', blocked_by: ['T1'] },
    { id: 'T3', task: 'c', dept: '', blocked_by: ['T1', 'T2'] }, // T1→T3: depth 0→2 (한 열 건너뜀)
  ]);
  const long = g.edges.find(e => e.from === 'T1' && e.to === 'T3');
  assert.ok(long.route.length >= 3, '중간 웨이포인트가 있어야 한다');
});

test('[박스회피] 샘플01: 어떤 엣지 route 점도 노드 박스 내부를 지나지 않는다', () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', '샘플01_신스키마.json'), 'utf8'));
  const g = buildGraph(d.sequence);
  g.edges.forEach(e => {
    e.route.forEach(p => {
      g.nodes.forEach(n => {
        const insideX = p.x > n.x && p.x < n.x + NODE_W;
        const insideY = p.y > n.y && p.y < n.y + NODE_H;
        assert.ok(!(insideX && insideY), e.from + '→' + e.to + ' route가 ' + n.id + ' 박스 내부 통과 (' + p.x + ',' + p.y + ')');
      });
    });
  });
});

// ── inferRoundNo (지시 15) ──────────────────────────────────────────────
const { inferRoundNo } = require('../B_직접/앱/board-derive.js');
test('inferRoundNo: "N차"·"버전 N"·첫 정수 우선순위로 회차 번호를 뽑는다', () => {
  assert.equal(inferRoundNo('진행 2차 - 중간 점검 (2026-08-04).md'), 2);
  assert.equal(inferRoundNo('진행 1차 - 킥오프 기획 (2026-07-21).md'), 1);
  assert.equal(inferRoundNo('버전 1 매우 꼼꼼한 버전 (풀 디테일).md'), 1);
  assert.equal(inferRoundNo('버전 2-중간 버전 (실무형 간결 정리).md'), 2);
  assert.equal(inferRoundNo('진행 10차 실행'), 10);
  assert.equal(inferRoundNo('2026-07-21 진행 3차'), 3); // 날짜 속 숫자보다 'N차' 우선
});
test('inferRoundNo: 숫자가 없으면 null, 0/음수는 null', () => {
  assert.equal(inferRoundNo('킥오프 메모.md'), null);
  assert.equal(inferRoundNo(''), null);
  assert.equal(inferRoundNo(null), null);
  assert.equal(inferRoundNo('0차'), null);
});
test('[자체감사] inferRoundNo: "N차"·"버전 N" 패턴이 전혀 없는 날짜형 파일명은 연도/날짜를 회차번호로 오인하지 않고 null을 반환한다', () => {
  // 'N차'/'버전 N'이 없을 때만 쓰는 최후 폴백(첫 정수)이 날짜에서 연도(4자리 이상)를 뽑아버리면,
  // 그 값이 그대로 저장 회차번호가 되어 이후 자동 채번(maxNo+1)까지 전부 오염된다(자체감사 발견).
  assert.equal(inferRoundNo('2026-03-15 회의.md'), null, '연도만 있고 N차/버전N이 없으면 null');
  assert.equal(inferRoundNo('2026년 3월 회의록'), null);
  assert.equal(inferRoundNo('20260315_회의록.md'), null, '전체 날짜(8자리)도 회차번호로 오인하면 안 된다');
  // 'N차'/'버전 N'가 있으면 날짜가 같이 있어도 여전히 그쪽이 우선(기존 동작 유지, 회귀 없음).
  assert.equal(inferRoundNo('2026-03-15 3차 회의.md'), 3);
});
