/* 조정치 · Vercel 서버리스 자동 모드 — 로컬 러너의 `claude -p` 대신 OpenAI Chat Completions API를
   OPENAI_API_KEY(Vercel 환경변수)로 직접 호출한다. 클라이언트(index.html)는 SSE 이벤트
   {t:조각} / {error} / {done,markdown}만 보고 동작하므로, 이 셋만 로컬 러너와 동일하게
   맞추면 클라이언트 코드는 한 글자도 안 건드려도 된다(analyze()가 이미 이 셋만 소비함).

   로컬 러너(server.py)와의 차이:
   - AGENT.md를 system 메시지로, 회의록을 user 메시지로 분리해서 보낸다(러너는 CLI 특성상
     하나로 이어붙임 — Chat Completions는 system/user 분리가 정석이라 더 정확한 사용법).
   - json/savedTo는 안 보낸다 — 클라이언트가 markdown만으로 parseResult()를 스스로 돌린다
     (복붙 모드와 동일 경로, 이미 검증된 로직이라 서버에서 또 파싱할 필요가 없다).
   - 결과 파일 저장은 없다(서버리스 파일시스템은 영속적이지 않다).
   - 모델 드롭다운(index.html #modelSel)은 Claude 모델명을 그대로 보내므로, 여기서 OpenAI
     모델명으로 매핑한다(속도/균형/정밀 의도는 유지) — 모르는 값·빈 값은 기본 모델로 폴백. */
const fs = require('fs');
const path = require('path');
const BoardCustom = require('../board-custom.js');

const OPENAI_MODEL_MAP = {
  'claude-haiku-4-5-20251001': 'gpt-4o-mini',   // 최속
  'claude-sonnet-5': 'gpt-4o',                  // 균형
  'claude-opus-4-8': 'gpt-4.1'                  // 정밀
};
const DEFAULT_MODEL = 'gpt-4o';
const MAX_NOTE_LEN = 100000;   // project-store.js MAX_NOTE_LEN과 동일 기준(과도한 요청·비용 방지)
const MAX_TOKENS = 8192;

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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return sendJson(res, 500, { error: '서버에 OPENAI_API_KEY 환경변수가 설정되어 있지 않습니다. Vercel 프로젝트 Settings → Environment Variables에서 추가 후 재배포하세요.' });
  }

  const reqModel = (typeof body.model === 'string' ? body.model : '').trim();
  const model = OPENAI_MODEL_MAP[reqModel] || DEFAULT_MODEL;

  let system;
  try {
    const agentMd = fs.readFileSync(path.join(process.cwd(), 'AGENT.md'), 'utf-8');
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
    upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        stream: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMsg }
        ]
      })
    });
  } catch (e) {
    sse({ error: 'OpenAI API 호출 실패: ' + e.message });
    return res.end();
  }

  if (!upstream.ok || !upstream.body) {
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 500); } catch (e) {}
    sse({ error: `OpenAI API 오류(${upstream.status}): ${detail}` });
    return res.end();
  }

  // OpenAI 스트림: "data: <json>\n\n" 반복, 끝에 "data: [DONE]"(JSON 아님, 특수 종료 신호).
  // choices[0].delta.content만 우리 클라이언트가 아는 {t:조각} 형식으로 다시 실어 나른다.
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
        const payload = dataLine.slice(5).trim();
        if (payload === '[DONE]') continue;   // 종료 신호 — 실제 done 이벤트는 스트림 끝에서 별도로 보낸다
        let evt;
        try { evt = JSON.parse(payload); } catch (e) { continue; }
        if (evt.error) { sse({ error: evt.error.message || 'OpenAI 스트림 오류' }); continue; }
        const delta = evt.choices && evt.choices[0] && evt.choices[0].delta;
        if (delta && typeof delta.content === 'string' && delta.content) {
          full += delta.content;
          sse({ t: delta.content });
        }
      }
    }
  } catch (e) {
    sse({ error: '스트림 읽기 실패: ' + e.message });
  }

  sse({ done: true, markdown: full });   // json 생략 → 클라이언트가 parseResult(markdown)로 직접 추출(복붙 모드와 동일 경로)
  res.end();
};
