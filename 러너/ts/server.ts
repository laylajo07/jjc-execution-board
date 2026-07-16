// 조정치 공용 러너 (TypeScript · pnpm) — 웹앱 서빙 + `claude -p` 실행
// 로컬에 로그인된 Claude Code를 그대로 사용하므로 API 키가 필요 없습니다.
//
// 사용법:
//   pnpm install
//   pnpm start ../../B_직접/앱            # 기본 포트 8787
//   pnpm start ../../A_웹페이지/앱 8788   # 포트 지정
//
// 사전 준비: Claude Code 설치 & 로그인 (npm i -g @anthropic-ai/claude-code → `claude` 최초 로그인)

import http from 'node:http';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { spawn, exec } from 'node:child_process';
import path from 'node:path';

const APP_DIR = path.resolve(process.argv[2] ?? process.cwd());
const PORT = Number(process.argv[3] ?? 8787);
const NOTES_DIR = path.resolve(APP_DIR, '..', '..', '회의록');
const RESULT_DIR = path.join(APP_DIR, '결과');
const AGENT_MD = path.join(APP_DIR, 'AGENT.md');
const APPROACH = path.basename(path.dirname(APP_DIR));
const MODEL = process.env.CLAUDE_MODEL;

await mkdir(RESULT_DIR, { recursive: true });

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
};

function extractJson(text: string): unknown {
  const m = text.match(/```json\s*([\s\S]*?)```/i);
  let cand: string | null = m ? m[1] : null;
  if (!cand) { const s = text.indexOf('{'), e = text.lastIndexOf('}'); if (s >= 0 && e > s) cand = text.slice(s, e + 1); }
  if (!cand) return null;
  for (const c of [cand, cand.replace(/,\s*([}\]])/g, '$1')]) { try { return JSON.parse(c); } catch { /* retry */ } }
  return null;
}

function collectText(line: string): string {
  try {
    const ev = JSON.parse(line);
    if (ev?.type !== 'assistant') return '';
    return (ev.message?.content ?? [])
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text ?? '')
      .join('');
  } catch { return ''; }
}

// `claude -p --include-partial-messages` 가 내는 JSON Lines에서 실시간 텍스트 조각
// (stream_event → content_block_delta → delta.text)만 뽑는다.
// (thinking_delta 등 text 필드가 없는 델타는 자동으로 걸러진다.)
function collectDelta(line: string): string {
  try {
    const ev = JSON.parse(line);
    if (ev?.type !== 'stream_event') return '';
    const inner = ev.event ?? {};
    if (inner?.type !== 'content_block_delta') return '';
    return inner.delta?.text ?? '';
  } catch { return ''; }
}

function runClaude(prompt: string, model?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']; const use = model || MODEL; if (use) args.push('--model', use);
    const cp = spawn('claude', args, { shell: process.platform === 'win32' });
    let out = '', err = '';
    const timer = setTimeout(() => { cp.kill(); reject(new Error('시간 초과(300s)')); }, 300_000);
    cp.stdout.on('data', d => (out += d));
    cp.stderr.on('data', d => (err += d));
    cp.on('error', reject);
    cp.on('close', code => {
      clearTimeout(timer);
      const raw = out.split('\n').map(collectText).join('');
      code === 0 ? resolve(raw) : reject(new Error(err || raw || 'claude 실패'));
    });
    cp.stdin.write(prompt); cp.stdin.end();
  });
}

function sendJson(res: http.ServerResponse, code: number, obj: unknown) {
  const b = Buffer.from(JSON.stringify(obj), 'utf-8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (u.pathname === '/api/health')
      return sendJson(res, 200, { ok: true, approach: APPROACH, appDir: APP_DIR, notesDir: NOTES_DIR });

    if (u.pathname === '/api/notes') {
      let items: { name: string }[] = [];
      try { const files = await readdir(NOTES_DIR); items = files.filter(f => /\.(md|txt)$/i.test(f) && !/^readme\.md$/i.test(f)).sort().map(name => ({ name })); } catch { /* empty */ }
      return sendJson(res, 200, items);
    }

    if (u.pathname === '/api/note') {
      const name = path.basename(u.searchParams.get('name') ?? '');
      try { const content = await readFile(path.join(NOTES_DIR, name), 'utf-8'); return sendJson(res, 200, { name, content }); }
      catch { return sendJson(res, 404, { error: 'not found' }); }
    }

    if (u.pathname === '/api/analyze' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const parsed = JSON.parse(body || '{}');
      const note = String(parsed.note ?? '').trim();
      let model = String(parsed.model ?? '').trim() || undefined;
      const name = String(parsed.name ?? '').trim(); // 선택한 회의록 파일명(있으면 결과 파일명에 사용)
      if (model && !/^[\w.:-]+$/.test(model)) model = undefined; // 셸 주입 방지: 모델명 화이트리스트
      if (!note) return sendJson(res, 400, { error: 'empty note' });
      const agent = await readFile(AGENT_MD, 'utf-8');
      const prompt = agent +
        '\n\n================================================================\n# 처리할 회의록 (형식 그대로)\n' +
        '================================================================\n' + note +
        '\n\n위 지침에 따라 "A. 실행보드(마크다운)"와 "B. JSON" 두 블록을 순서대로 출력해줘.';
      // ── SSE 스트리밍 응답 ──
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      const sse = (obj: unknown) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { /* client gone */ } };
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']; const use = model || MODEL; if (use) args.push('--model', use);
      const cp = spawn('claude', args, { shell: process.platform === 'win32' });
      let buf = '', err = ''; const textParts: string[] = [];
      const timer = setTimeout(() => cp.kill(), 300_000);
      cp.stdout.on('data', d => {
        buf += d.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const ln = buf.slice(0, idx); buf = buf.slice(idx + 1);
          const text = collectText(ln); if (text) textParts.push(text);  // 최종 조립용(collectText) — SSE로는 보내지 않음
          const delta = collectDelta(ln); if (delta) sse({ t: delta });  // 생성되는 텍스트 조각만 실시간 전달
        }
      });
      cp.stderr.on('data', d => { err += d.toString(); });
      cp.on('error', e => { clearTimeout(timer); sse({ error: String((e as Error).message ?? e) }); res.end(); });
      cp.on('close', async code => {
        clearTimeout(timer);
        if (buf.trim()) { const text = collectText(buf); if (text) textParts.push(text); }
        const raw = textParts.join('');
        if (code !== 0 && !raw.trim()) { sse({ error: err.trim() || 'claude 실패' }); return res.end(); }
        const data = extractJson(raw);
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const stem = name ? path.basename(name).replace(/\.[^.]+$/, '').replace(/[^\w.\-]/g, '_') : '';
        const baseName = stem ? `${stem}__${ts}` : ts;
        try {
          await writeFile(path.join(RESULT_DIR, baseName + '.md'), raw, 'utf-8');
          if (data) await writeFile(path.join(RESULT_DIR, baseName + '.json'), JSON.stringify(data, null, 2), 'utf-8');
        } catch { /* ignore */ }
        sse({ done: true, markdown: raw, json: data, savedTo: baseName + '.md' });
        res.end();
      });
      cp.stdin.write(prompt); cp.stdin.end();
      return;
    }

    // 정적 파일 서빙
    let p = decodeURIComponent(u.pathname ?? '/'); if (p === '/') p = '/index.html';
    const fp = path.join(APP_DIR, p);
    if (!fp.startsWith(APP_DIR)) { res.writeHead(403); return res.end('forbidden'); }
    try { const data = await readFile(fp); res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] ?? 'application/octet-stream' }); res.end(data); }
    catch { res.writeHead(404); res.end('not found'); }
  } catch (e) { sendJson(res, 500, { error: String((e as Error).message ?? e) }); }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[조정치 러너/ts] ${APPROACH}  http://localhost:${PORT}`);
  console.log(`  앱 폴더   : ${APP_DIR}`);
  console.log(`  회의록 폴더: ${NOTES_DIR}`);
  const open = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${open} http://localhost:${PORT}`);
});
