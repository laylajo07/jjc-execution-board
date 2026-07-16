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
