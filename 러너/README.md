# 조정치 공용 러너 (자동 모드)

웹앱을 로컬에서 띄우고, **[분석] 버튼 → 로컬에 로그인된 Claude Code(`claude -p`)** 를 실행해
회의록을 구조화한 뒤 결과를 웹앱에 표시합니다. **Anthropic API 키가 필요 없습니다** —
당신의 Claude Code 로그인 세션을 그대로 사용합니다.

접근법 A(`A_웹페이지/앱`)와 B(`B_직접/앱`)에 **공통으로** 쓰는 러너입니다.
러너에 어느 앱 폴더를 넘기느냐에 따라 그 폴더의 `AGENT.md`(시스템 프롬프트)를 사용합니다.

## 0. 사전 준비 (최초 1회)
```bash
npm install -g @anthropic-ai/claude-code   # Claude Code 설치 (Node 18+)
claude                                       # 실행 후 로그인 (구독 로그인 = API 키 불필요)
```

## 1-A. TypeScript + pnpm 러너 (권장)
```bash
cd 러너/ts
pnpm install
pnpm start:B      # 접근법 B 앱을  http://localhost:8787 로
# 또는
pnpm start:A      # 접근법 A 앱을  http://localhost:8788 로
# 임의 지정:  pnpm start <앱폴더경로> [포트]
```

## 1-B. Python 러너 (설치 0 · 폴백)
```bash
cd 러너/py
python server.py ../../B_직접/앱          # http://localhost:8787
python server.py ../../A_웹페이지/앱 8788  # 포트 지정
```

## 2. 사용
1. 브라우저가 자동으로 열립니다(안 열리면 위 주소 접속). 앱은 **기본이 📋 복붙 모드**입니다 —
   러너로 자동 실행하려면 헤더의 **모드 표시등을 클릭해 ⚡ 자동 모드로 전환**하세요(러너가 켜져 있으면 전환됩니다).
2. 자동 모드에서 `회의록`의 회의록을 고르거나 직접 붙여넣습니다.
3. 헤더의 **모델 드롭다운**에서 모델을 고릅니다(러너 기본 / Haiku·Sonnet·Opus).
4. **[회의록 분석]** → 로컬 Claude가 처리 → 부서별 실행보드가 렌더링되고,
   결과가 `<앱폴더>/결과/`에 `.md`, `.json`으로 저장됩니다.

## 동작 원리
```
브라우저(웹앱) ──POST /api/analyze──▶ 러너 ──stdin──▶  claude -p  (로컬 로그인)
      ▲                                   │                     │
      └────────── JSON/마크다운 ◀──────────┴── 결과/ 저장 ◀──────┘
```
러너는 `<앱폴더>/AGENT.md` + `# 처리할 회의록` + 회의록 텍스트를 이어붙여 `claude -p`에 전달합니다.
응답은 **SSE(text/event-stream)로 스트리밍**되어, 생성되는 내용이 웹앱에 실시간으로 표시됩니다
(단, `claude -p` 세션 부팅 동안은 아직 출력이 없어 프리뷰가 비어 있다가, 생성이 시작되면 흐릅니다).

## 모델 선택
- **웹앱 헤더 드롭다운**(자동 모드)에서 요청마다 모델을 고릅니다 → 러너가 `claude -p --model <id>` 로 실행.
- 기본값은 "러너 기본"(플래그 없이 = 당신의 Claude Code 기본 모델).
- 환경변수로도 지정 가능:  `CLAUDE_MODEL=claude-sonnet-5 pnpm start:B` (UI 선택이 있으면 그게 우선).
- 모델 id: `claude-haiku-4-5-20251001`(최속) · `claude-sonnet-5`(균형) · `claude-opus-4-8`(정밀).

## 참고 / 문제해결
- **러너 없이도** 각 `앱/index.html` 을 더블클릭하면 **복붙 모드**로 동작합니다(러너·Node·Python 불필요).
- `claude`를 못 찾는다는 오류: Claude Code가 설치·로그인됐는지, 새 터미널에서 `claude --version` 확인.
- **응답 지연**: `claude -p`는 매 요청마다 Claude Code 세션을 새로 부팅하므로 **모델과 무관하게 1~3분** 걸릴 수 있습니다(정상).
  세션 부팅 오버헤드가 대부분이라 빠른 모델을 골라도 크게 줄지 않습니다. **반복적으로 빠르게** 쓰려면
  이미 로그인된 창에 붙여넣는 **복붙 모드**가 체감상 더 빠릅니다.
- TS 러너 `pnpm install` 시 esbuild 빌드 승인 경고가 나면 → `ts/pnpm-workspace.yaml` 의 `allowBuilds: esbuild: true` 로 해결돼 있습니다(재설치하면 자동 빌드).
- 포트 충돌 시 다른 포트를 인자로 지정하세요.
