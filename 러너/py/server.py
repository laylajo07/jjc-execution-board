#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 조정치 공용 러너 (Python · 설치 0) — 웹앱 서빙 + `claude -p` 실행
# 로컬에 로그인된 Claude Code를 그대로 사용하므로 API 키가 필요 없습니다.
#
# 사용법:
#   python server.py <앱폴더> [포트]
#   예) python server.py ../../B_직접/앱
#       python server.py ../../A_웹페이지/앱 8788
#
# 사전 준비: Claude Code 설치 & 로그인  (npm i -g @anthropic-ai/claude-code, 그 후 `claude` 로 최초 로그인)

import sys, os, json, subprocess, urllib.parse, http.server, socketserver, datetime, re, threading, webbrowser

# 아래 값들은 실행 설정(CLI 인자)이라 `_configure()` 안에서만 채운다.
# 모듈을 그냥 import 할 때(예: 테스트에서 `from server import collect_text`)는
# sys.argv를 건드리거나 결과 폴더를 만드는 부작용이 없어야 하기 때문이다.
APP_DIR = PORT = NOTES_DIR = RESULT_DIR = AGENT_MD = APPROACH = MODEL = None

# ── 부서 커스터마이징 정규화 (B_직접/앱/board-custom.js 의 sanitize 규칙과 동일 — 3개 언어 중 하나) ──
# 문자열당 최대 길이(부서명·매핑 raw·dept 공통)
DEPT_MAX_NAME_LEN = 40
# customDepts 최대 개수
DEPT_MAX_CUSTOM_DEPTS = 30
# customMappings 최대 개수
DEPT_MAX_CUSTOM_MAPPINGS = 60
# 표준 6본부 — 추가만 가능, 삭제 불가. 커스텀 부서 중 이름이 겹치면 버린다.
DEPT_STD_DEPTS = ('CB본부', 'ICT본부', '경영본부', '법무실', '고객솔루션본부', '사업성장본부')
# customTeams 최대 개수(본부 → 팀 계층, 3개 언어 중 하나)
DEPT_MAX_CUSTOM_TEAMS = 60

_DEPT_CONTROL_CHARS_RE = re.compile(r'[\x00-\x1F\x7F-\x9F]')
# JS의 (유니코드 비인식) \s는 U+FEFF(BOM/ZWNBSP)를 공백으로 취급하지만 파이썬의
# 유니코드 모드 \s는 그렇지 않다 — board-custom.js와 같은 결과를 내려면 명시적으로 넣어야 한다.
# (전수 스캔 결과 이 외의 \s 불일치(U+001C-001F, U+0085)는 위 제어문자 정규식이 먼저
# 공백으로 치환해 버리므로 여기 도달하기 전에 이미 동일해져 무해하다.)
_DEPT_WHITESPACE_RE = re.compile(r'[\s\uFEFF]+')


def sanitize_dept_name(s):
    """제어문자·개행을 공백으로 → 연속 공백 접기 → trim → 길이 컷. 문자열이 아니면 빈 문자열."""
    if not isinstance(s, str):
        return ''
    cleaned = _DEPT_WHITESPACE_RE.sub(' ', _DEPT_CONTROL_CHARS_RE.sub(' ', s)).strip()
    if len(cleaned) > DEPT_MAX_NAME_LEN:
        cleaned = cleaned[:DEPT_MAX_NAME_LEN].strip()
    return cleaned


def sanitize_depts(arr):
    if not isinstance(arr, list):
        return []
    std_set = set(DEPT_STD_DEPTS)
    seen = set()
    out = []
    for item in arr:
        if len(out) >= DEPT_MAX_CUSTOM_DEPTS:
            break
        name = sanitize_dept_name(item)
        if not name or name in std_set or name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def sanitize_teams(arr, depts, removed_std):
    """본부 → 팀 계층(board-custom.js sanitizeTeams 와 동일 규칙). depts는 이미 sanitize_depts를
    거친 customDepts 목록, removed_std는 사용자가 제외한 표준 본부 목록 — parent가 "현재 소속
    가능한" 본부(표준 6본부 중 제외되지 않은 것·customDepts) 어디에도 없으면 소속 미정으로
    강등한다. 팀명은 제외 여부와 무관하게 표준 6본부·customDepts 전체와 겹치면 버린다."""
    if not isinstance(arr, list):
        return []
    name_set = set(DEPT_STD_DEPTS) | set(depts or [])
    removed_set = set(removed_std or [])
    parent_set = (set(DEPT_STD_DEPTS) - removed_set) | set(depts or [])
    seen = set()
    out = []
    for item in arr:
        if len(out) >= DEPT_MAX_CUSTOM_TEAMS:
            break
        if not isinstance(item, dict):
            continue
        name = sanitize_dept_name(item.get('name'))
        if not name or name in name_set or name in seen:
            continue
        parent = sanitize_dept_name(item.get('parent'))
        if parent and parent not in parent_set:
            parent = ''
        seen.add(name)
        out.append({'name': name, 'parent': parent})
    return out


def sanitize_removed_std_depts(arr):
    """사용자가 제외한 표준 본부 목록 — 표준 6본부 중 값만 남기고, 표준 6본부의 고정 순서로
    정렬해 반환한다(입력 순서에 의존하지 않는 결정적 결과)."""
    if not isinstance(arr, list):
        return []
    std_set = set(DEPT_STD_DEPTS)
    seen = set()
    for item in arr:
        name = sanitize_dept_name(item)
        if name and name in std_set:
            seen.add(name)
    return [d for d in DEPT_STD_DEPTS if d in seen]


def sanitize_mappings(arr):
    if not isinstance(arr, list):
        return []
    seen_raw = set()
    out = []
    for m in arr:
        if len(out) >= DEPT_MAX_CUSTOM_MAPPINGS:
            break
        if not isinstance(m, dict):
            continue
        raw = sanitize_dept_name(m.get('raw'))
        dept = sanitize_dept_name(m.get('dept'))
        if not raw or not dept or raw in seen_raw:
            continue
        seen_raw.add(raw)
        out.append({'raw': raw, 'dept': dept})
    return out


def sanitize_dept_config(config):
    """방어적 정규화(순수). 항상 {'customDepts': [], 'customTeams': [], 'customMappings': [],
    'removedStdDepts': []} 모양을 반환한다."""
    src = config if isinstance(config, dict) else {}
    depts = sanitize_depts(src.get('customDepts'))
    removed_std = sanitize_removed_std_depts(src.get('removedStdDepts'))
    return {
        'customDepts': depts,
        'customTeams': sanitize_teams(src.get('customTeams'), depts, removed_std),
        'customMappings': sanitize_mappings(src.get('customMappings')),
        'removedStdDepts': removed_std,
    }


def teams_line(teams):
    """customTeams → "본부 소속(팀, 팀); 소속 미정(팀)" 한 줄 요약. teams는 이미 sanitize를 거친 리스트."""
    by_parent = {}
    order = []
    unassigned = []
    for t in teams:
        if t['parent']:
            if t['parent'] not in by_parent:
                by_parent[t['parent']] = []
                order.append(t['parent'])
            by_parent[t['parent']].append(t['name'])
        else:
            unassigned.append(t['name'])
    parts = [p + ' 소속(' + ', '.join(by_parent[p]) + ')' for p in order]
    if unassigned:
        parts.append('소속 미정(' + ', '.join(unassigned) + ')')
    return '; '.join(parts)


def dept_config_to_prompt(config):
    """설정 → 프롬프트 블록(board-custom.js deptConfigToPrompt 과 문구·형식 동일, 팀 계층·표준 본부
    제외 포함). 비어 있으면 ''."""
    c = sanitize_dept_config(config)
    if not c['customDepts'] and not c['customTeams'] and not c['customMappings'] and not c['removedStdDepts']:
        return ''
    lines = ['[사용자 추가 부서 — 표준 본부와 동일하게 취급]']
    if c['customDepts']:
        lines.append('- 추가 부서: ' + ', '.join(c['customDepts']))
    if c['customTeams']:
        lines.append('- 등록된 팀: ' + teams_line(c['customTeams']))
    if c['customMappings']:
        lines.append('- 매핑(우선 적용): ' + ', '.join(
            '"' + m['raw'] + '"→' + m['dept'] for m in c['customMappings']))
    if c['removedStdDepts']:
        lines.append('- 제외된 표준 본부: ' + ', '.join(c['removedStdDepts']))
    lines.append(
        '표준 6본부(제외된 표준 본부는 제외) + 위 추가 부서를 모두 사용 가능. 매핑 규칙을 표준화보다 우선한다.'
        if c['removedStdDepts']
        else '표준 6본부 + 위 추가 부서를 모두 사용 가능. 매핑 규칙을 표준화보다 우선한다.'
    )
    if c['customTeams']:
        lines.append('등록된 팀은 원문에 나오면 그 팀명을 그대로 dept 값에 쓴다(소속 본부가 있으면 "본부명(팀명)" 형식).')
    if c['removedStdDepts']:
        lines.append('제외된 표준 본부는 더 이상 매핑 대상이 아니다. 원문에 나와도 다른 표준 본부나 추가 부서로 재분류하거나, 마땅한 곳이 없으면 원문 표기 그대로 쓰고 "[본부 확인필요]"를 병기한다.')
    return '\n'.join(lines)


def dept_prompt_block(dept_config):
    """AGENT.md 뒤에 이어붙일 블록. 앞에 '\\n\\n'을 포함(비면 ''). deptConfig 가 없거나 이상해도
    예외를 절대 밖으로 내지 않는다 — 러너가 이 때문에 500을 내면 안 된다(설계 5절)."""
    try:
        text = dept_config_to_prompt(dept_config)
    except Exception:
        return ''
    return ('\n\n' + text) if text else ''


def _configure():
    """CLI 인자로 실행 설정을 채우고 결과 폴더를 만든다. `python server.py ...` 로
    직접 실행할 때(`__main__`)만 호출한다."""
    global APP_DIR, PORT, NOTES_DIR, RESULT_DIR, AGENT_MD, APPROACH, MODEL
    APP_DIR = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.getcwd()
    PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8787
    NOTES_DIR = os.path.abspath(os.path.join(APP_DIR, '..', '..', '회의록'))
    RESULT_DIR = os.path.join(APP_DIR, '결과')
    AGENT_MD = os.path.join(APP_DIR, 'AGENT.md')
    APPROACH = os.path.basename(os.path.dirname(APP_DIR))
    MODEL = os.environ.get('CLAUDE_MODEL')
    os.makedirs(RESULT_DIR, exist_ok=True)


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def collect_text(lines):
    """`claude -p --output-format stream-json` 의 JSON Lines에서 assistant 텍스트만 조립한다."""
    out = []
    for ln in lines:
        ln = (ln or '').strip()
        if not ln:
            continue
        try:
            ev = json.loads(ln)
        except Exception:
            continue  # 깨진 라인은 무시
        if ev.get('type') != 'assistant':
            continue
        for blk in (ev.get('message') or {}).get('content') or []:
            if blk.get('type') == 'text':
                out.append(blk.get('text') or '')
    return ''.join(out)


def collect_delta(lines):
    """`claude -p --include-partial-messages` 가 내는 JSON Lines에서
    실시간 텍스트 조각(stream_event → content_block_delta → delta.text)만 뽑는다.
    (thinking_delta 등 text 필드가 없는 델타는 자동으로 걸러진다.)"""
    out = []
    for ln in lines:
        ln = (ln or '').strip()
        if not ln:
            continue
        try:
            ev = json.loads(ln)
        except Exception:
            continue  # 깨진 라인은 무시
        if ev.get('type') != 'stream_event':
            continue
        inner = ev.get('event') or {}
        if inner.get('type') != 'content_block_delta':
            continue
        text = (inner.get('delta') or {}).get('text')
        if text:
            out.append(text)
    return ''.join(out)


def extract_json(text):
    m = re.search(r'```json\s*(.*?)```', text, re.S)
    cand = m.group(1) if m else None
    if not cand:
        s, e = text.find('{'), text.rfind('}')
        if s >= 0 and e > s:
            cand = text[s:e + 1]
    if not cand:
        return None
    for c in (cand, re.sub(r',\s*([}\]])', r'\1', cand)):
        try:
            return json.loads(c)
        except Exception:
            pass
    return None


def stamp_updated(data, when=None):
    """data가 dict면 updated_at(로컬 오프셋 ISO, 초 단위)을 넣은 얕은 사본을 반환. 아니면 그대로."""
    if not isinstance(data, dict):
        return data
    ts = (when or datetime.datetime.now().astimezone()).isoformat(timespec='seconds')
    out = dict(data)
    out['updated_at'] = ts
    return out


def run_claude(prompt, model=None):
    args = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    use = model or MODEL
    if use:
        args += ['--model', use]
    p = subprocess.run(args, input=prompt, capture_output=True, text=True,
                       encoding='utf-8', shell=(os.name == 'nt'), timeout=300)
    raw = collect_text(p.stdout.splitlines())
    if p.returncode != 0 and not raw.strip():
        raise RuntimeError((p.stderr or p.stdout or 'claude 실행 실패').strip())
    return raw


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=APP_DIR, **k)

    def _send(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/api/health':
            return self._send(200, {'ok': True, 'approach': APPROACH, 'appDir': APP_DIR, 'notesDir': NOTES_DIR})
        if u.path == '/api/notes':
            items = []
            if os.path.isdir(NOTES_DIR):
                for n in sorted(os.listdir(NOTES_DIR)):
                    if n.lower().endswith(('.md', '.txt')) and n.lower() != 'readme.md':
                        items.append({'name': n})
            return self._send(200, items)
        if u.path == '/api/note':
            q = urllib.parse.parse_qs(u.query)
            name = os.path.basename((q.get('name') or [''])[0])
            fp = os.path.join(NOTES_DIR, name)
            if os.path.isfile(fp):
                return self._send(200, {'name': name, 'content': read(fp)})
            return self._send(404, {'error': 'not found'})
        return super().do_GET()

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != '/api/analyze':
            return self._send(404, {'error': 'unknown'})
        # SSE 응답(send_response)을 시작하기 전 단계다 — 여기서 예외가 나면(예: AGENT_MD가
        # 앱 폴더 경로 오지정 등으로 없거나, body가 JSON이 아니거나) try/except 없이는 아직
        # 아무 응답도 안 보낸 채로 소켓만 끊겨, 브라우저 쪽엔 {error:...} JSON이 아니라
        # 원인불명 네트워크 에러("Failed to fetch")만 보인다. server.ts는 핸들러 전체를
        # try/except로 감싸 이 경로에서도 깔끔한 500 JSON을 주는데, 여기는 안 그래서 자동모드
        # 기능 동등성이 깨져 있었다(자체감사 발견) — 같은 방식으로 감싼다.
        try:
            ln = int(self.headers.get('Content-Length', '0'))
            body = json.loads(self.rfile.read(ln) or b'{}')
            note = (body.get('note') or '').strip()
            model = (body.get('model') or '').strip() or None
            name = (body.get('name') or '').strip()  # 선택한 회의록 파일명(있으면 결과 파일명에 사용)
            if model and not re.match(r'^[\w.:-]+$', model):  # 셸 주입 방지: 모델명 화이트리스트
                model = None
            if not note:
                return self._send(400, {'error': 'empty note'})
            dept_block = dept_prompt_block(body.get('deptConfig'))
            prompt = (read(AGENT_MD) + dept_block +
                      "\n\n================================================================\n"
                      "# 처리할 회의록 (형식 그대로)\n"
                      "================================================================\n" + note +
                      "\n\n위 지침에 따라 \"A. 실행보드(마크다운)\"와 \"B. JSON\" 두 블록을 순서대로 출력해줘.")
        except Exception as e:
            return self._send(500, {'error': str(e)})
        # ── SSE 스트리밍 응답 ──
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers()

        def sse(obj):
            try:
                self.wfile.write(('data: ' + json.dumps(obj, ensure_ascii=False) + '\n\n').encode('utf-8'))
                self.wfile.flush()
            except Exception:
                pass

        args = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
        use = model or MODEL
        if use:
            args += ['--model', use]
        try:
            proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, shell=(os.name == 'nt'))
            proc.stdin.write(prompt.encode('utf-8'))
            proc.stdin.close()
        except Exception as e:
            return sse({'error': str(e)})

        buf, lines = '', []
        while True:
            b = proc.stdout.read1(4096)
            if not b:
                break
            buf += b.decode('utf-8', 'replace')
            while '\n' in buf:
                ln, buf = buf.split('\n', 1)
                lines.append(ln)
                # SSE에는 델타(조각)만 흘린다 — assistant 텍스트(collect_text)까지 같이
                # 보내면 미리보기에 같은 내용이 두 번 나온다. 최종 조립은 아래 collect_text(lines)만 담당.
                piece = collect_delta([ln])
                if piece:
                    sse({'t': piece})       # 생성되는 텍스트 조각을 실시간 전달
        if buf.strip():
            lines.append(buf)
        proc.wait()
        raw = collect_text(lines)
        if proc.returncode != 0 and not raw.strip():
            err = proc.stderr.read().decode('utf-8', 'replace').strip()
            return sse({'error': err or 'claude 실행 실패'})

        data = stamp_updated(extract_json(raw))
        ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        stem = re.sub(r'[^\w.\-]', '_', os.path.splitext(os.path.basename(name))[0]) if name else ''
        base = os.path.join(RESULT_DIR, (stem + '__' + ts) if stem else ts)
        try:
            with open(base + '.md', 'w', encoding='utf-8') as f:
                f.write(raw)
            if data is not None:
                with open(base + '.json', 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
        sse({'done': True, 'markdown': raw, 'json': data, 'savedTo': os.path.basename(base) + '.md'})

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    _configure()
    print(f"[조정치 러너/py] {APPROACH}  http://localhost:{PORT}")
    print(f"  앱 폴더   : {APP_DIR}")
    print(f"  회의록 폴더: {NOTES_DIR}")
    print("  종료: Ctrl+C")
    threading.Timer(0.8, lambda: webbrowser.open(f'http://localhost:{PORT}')).start()
    with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), H) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n종료합니다.')
