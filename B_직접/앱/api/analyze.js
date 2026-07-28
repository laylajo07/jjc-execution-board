/* 조정치 · Vercel 서버리스 자동 모드 — 로컬 러너의 `claude -p` 대신 Anthropic Messages API를
   ANTHROPIC_API_KEY(Vercel 환경변수)로 직접 호출한다. 클라이언트(index.html)는 SSE 이벤트
   {t:조각} / {error} / {done,markdown}만 보고 동작하므로, 이 셋만 로컬 러너와 동일하게
   맞추면 클라이언트 코드는 한 글자도 안 건드려도 된다(analyze()가 이미 이 셋만 소비함).

   로컬 러너(server.py)와의 차이:
   - AGENT.md를 system 프롬프트로, 회의록을 user 메시지로 분리해서 보낸다(러너는 CLI 특성상
     하나로 이어붙임 — API는 system/user 분리가 정석이라 더 정확한 사용법).
   - json/savedTo는 안 보낸다 — 클라이언트가 markdown만으로 parseResult()를 스스로 돌린다
     (복붙 모드와 동일 경로, 이미 검증된 로직이라 서버에서 또 파싱할 필요가 없다).
   - 결과 파일 저장은 없다(서버리스 파일시스템은 영속적이지 않다).

   (한때 OpenAI Chat Completions로 전환했었으나, 그 OpenAI 키가 조직 IP 허용목록에 걸려
   Vercel에서 401 ip_not_authorized가 나 다시 Anthropic으로 되돌림 — Vercel Settings →
   Environment Variables에 ANTHROPIC_API_KEY를 설정해야 자동 모드가 켜진다.) */
const fs = require('fs');
const path = require('path');
const BoardCustom = require('../board-custom.js');

const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_NOTE_LEN = 100000;   // project-store.js MAX_NOTE_LEN과 동일 기준(과도한 요청·비용 방지)
const MAX_TOKENS = 8192;

// Vercel Node 함수의 process.cwd()가 프로젝트 루트와 항상 같다는 보장이 없어(같은 폴더를
// 쓰는 notes.js/note.js에서 실제로 빈 결과가 나와 확인됨) __dirname 기준 후보도 같이 시도한다.
var AGENT_MD_CANDIDATES = [
  path.join(process.cwd(), 'AGENT.md'),
  path.join(__dirname, '..', 'AGENT.md'),
  path.join(__dirname, 'AGENT.md')
];
function readAgentMd() {
  for (var i = 0; i < AGENT_MD_CANDIDATES.length; i++) {
    try { return fs.readFileSync(AGENT_MD_CANDIDATES[i], 'utf-8'); } catch (e) {}
  }
  throw new Error('시도한 경로: ' + AGENT_MD_CANDIDATES.join(', '));
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 404, { error: 'unknown' });

  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
  } catch (e) {
    return sendJson(res, 400, { error: '요청 본문을 읽을 수 없습니다: ' + e.message });
  }

  const note = (typeof body.note === 'string' ? body.note : '').trim();
  if (!note) return sendJson(res, 400, { error: 'empty note' });
  if (note.length > MAX_NOTE_LEN) {
    return sendJson(res, 400, { error: `회의록이 너무 깁니다(${note.length}자). ${MAX_NOTE_LEN}자 이하로 줄여주세요.` });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return sendJson(res, 500, { error: '서버에 ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다. Vercel 프로젝트 Settings → Environment Variables에서 추가 후 재배포하세요.' });
  }

  let model = (typeof body.model === 'string' ? body.model : '').trim();
  if (model && !/^[\w.:-]+$/.test(model)) model = ''; // 값 화이트리스트(형식 검증)
  model = model || DEFAULT_MODEL;

  let system;
  try {
    const agentMd = readAgentMd();
    let deptText = '';
    try { deptText = BoardCustom.deptConfigToPrompt(body.deptConfig); } catch (e) { deptText = ''; }
    system = agentMd + (deptText ? ('\n\n' + deptText) : '');
  } catch (e) {
    return sendJson(res, 500, { error: 'AGENT.md를 읽을 수 없습니다: ' + e.message });
  }

  const userMsg = '# 처리할 회의록 (형식 그대로)\n' +
    '================================================================\n' + note +
    '\n\n위 지침에 따라 "A. 실행보드(마크다운)"와 "B. JSON" 두 블록을 순서대로 출력해줘.';

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const sse = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {} };

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, stream: true, system, messages: [{ role: 'user', content: userMsg }] })
    });
  } catch (e) {
    sse({ error: 'Anthropic API 호출 실패: ' + e.message });
    return res.end();
  }

  if (!upstream.ok || !upstream.body) {
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 500); } catch (e) {}
    sse({ error: `Anthropic API 오류(${upstream.status}): ${detail}` });
    return res.end();
  }

  // Anthropic 스트림: "event: <type>\ndata: <json>\n\n" 반복. content_block_delta의
  // delta.text_delta만 우리 클라이언트가 아는 {t:조각} 형식으로 다시 실어 나른다.
  let full = '', buf = '';
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = rawEvent.split('\n').find(function (l) { return l.indexOf('data:') === 0; });
        if (!dataLine) continue;
        let evt;
        try { evt = JSON.parse(dataLine.slice(5).trim()); } catch (e) { continue; }
        if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
          full += evt.delta.text;
          sse({ t: evt.delta.text });
        } else if (evt.type === 'error') {
          sse({ error: (evt.error && evt.error.message) || 'Anthropic 스트림 오류' });
        }
      }
    }
  } catch (e) {
    sse({ error: '스트림 읽기 실패: ' + e.message });
  }

  sse({ done: true, markdown: full });   // json 생략 → 클라이언트가 parseResult(markdown)로 직접 추출(복붙 모드와 동일 경로)
  res.end();
};
