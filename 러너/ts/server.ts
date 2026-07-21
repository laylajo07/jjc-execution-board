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

// ── 부서 커스터마이징 정규화 (B_직접/앱/board-custom.js 의 sanitize 규칙과 동일 — 3개 언어 중 하나) ──
const DEPT_MAX_NAME_LEN = 40;          // 문자열당 최대 길이(부서명·매핑 raw·dept 공통)
const DEPT_MAX_CUSTOM_DEPTS = 30;      // customDepts 최대 개수
const DEPT_MAX_CUSTOM_MAPPINGS = 60;   // customMappings 최대 개수
// 표준 6본부 — 추가만 가능, 삭제 불가. 커스텀 부서 중 이름이 겹치면 버린다.
const DEPT_STD_DEPTS = ['CB본부', 'ICT본부', '경영본부', '법무실', '고객솔루션본부', '사업성장본부'] as const;

type DeptMapping = { raw: string; dept: string };
type DeptConfig = { customDepts: string[]; customMappings: DeptMapping[] };

// 제어문자·개행을 공백으로 → 연속 공백 접기 → trim → 길이 컷. 문자열이 아니면 빈 문자열.
function sanitizeDeptName(s: unknown): string {
  if (typeof s !== 'string') return '';
  let cleaned = s.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim();
  // 코드 포인트 단위로 자른다(.slice(0,N)은 UTF-16 코드 유닛 단위라 서러게이트 쌍을
  // 반으로 잘라 홀로 남은 하이 서러게이트 같은 깨진 유니코드를 만들 수 있다).
  const codePoints = Array.from(cleaned);
  if (codePoints.length > DEPT_MAX_NAME_LEN) cleaned = codePoints.slice(0, DEPT_MAX_NAME_LEN).join('').trim();
  return cleaned;
}

function sanitizeDepts(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const std = new Set<string>(DEPT_STD_DEPTS);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < arr.length && out.length < DEPT_MAX_CUSTOM_DEPTS; i++) {
    const name = sanitizeDeptName(arr[i]);
    if (!name || std.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function sanitizeMappings(arr: unknown): DeptMapping[] {
  if (!Array.isArray(arr)) return [];
  const seenRaw = new Set<string>();
  const out: DeptMapping[] = [];
  for (let i = 0; i < arr.length && out.length < DEPT_MAX_CUSTOM_MAPPINGS; i++) {
    const m = arr[i];
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    const raw = sanitizeDeptName((m as Record<string, unknown>).raw);
    const dept = sanitizeDeptName((m as Record<string, unknown>).dept);
    if (!raw || !dept || seenRaw.has(raw)) continue;
    seenRaw.add(raw);
    out.push({ raw, dept });
  }
  return out;
}

// 방어적 정규화(순수). 항상 {customDepts:[], customMappings:[]} 모양을 반환한다.
function sanitizeDeptConfig(config: unknown): DeptConfig {
  const src = (config && typeof config === 'object' && !Array.isArray(config))
    ? (config as Record<string, unknown>) : {};
  return { customDepts: sanitizeDepts(src.customDepts), customMappings: sanitizeMappings(src.customMappings) };
}

// 설정 → 프롬프트 블록(board-custom.js deptConfigToPrompt 과 문구·형식 동일). 비어 있으면 ''.
function deptConfigToPrompt(config: unknown): string {
  const c = sanitizeDeptConfig(config);
  if (!c.customDepts.length && !c.customMappings.length) return '';
  const lines = ['[사용자 추가 부서 — 표준 본부와 동일하게 취급]'];
  if (c.customDepts.length) lines.push('- 추가 부서: ' + c.customDepts.join(', '));
  if (c.customMappings.length) {
    lines.push('- 매핑(우선 적용): ' + c.customMappings.map(m => `"${m.raw}"→${m.dept}`).join(', '));
  }
  lines.push('표준 6본부 + 위 추가 부서를 모두 사용 가능. 매핑 규칙을 표준화보다 우선한다.');
  return lines.join('\n');
}

// AGENT.md 뒤에 이어붙일 블록. 앞에 '\n\n'을 포함(비면 ''). deptConfig 가 없거나 이상해도
// 예외를 절대 밖으로 내지 않는다 — 러너가 이 때문에 500을 내면 안 된다(설계 5절).
function deptPromptBlock(deptConfig: unknown): string {
  try {
    const text = deptConfigToPrompt(deptConfig);
    return text ? '\n\n' + text : '';
  } catch {
    return '';
  }
}

// 클라이언트(index.html) nowIso()와 동일 형식: 로컬 오프셋 ISO 8601, 초 단위.
function nowIso(): string {
  const d = new Date(), z = -d.getTimezoneOffset(), s = z < 0 ? '-' : '+';
  const p = (n: number) => String(Math.abs(Math.trunc(n))).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${s}${p(z/60)}:${p(z%60)}`;
}

// data가 dict/객체(배열 제외)면 updated_at(생성 시각)을 넣은 얕은 사본을 반환. 아니면 그대로.
function stampUpdated(data: unknown): unknown {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), updated_at: nowIso() };
  }
  return data;
}

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
      const deptBlock = deptPromptBlock(parsed.deptConfig);
      const prompt = agent + deptBlock +
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
        const data = stampUpdated(extractJson(raw));
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
