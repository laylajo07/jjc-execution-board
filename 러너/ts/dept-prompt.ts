// 부서 커스터마이징 정규화 + 프롬프트 블록 (B_직접/앱/board-custom.js 의 sanitize·deptConfigToPrompt 와
// 문구·형식·규칙이 동일한 3개 언어 사본 중 하나 — JS/Python/TS). 순수(부작용 없음)하게 분리해
// dept-prompt.test.ts 가 공용 fixture(테스트/fixtures/dept-config-prompt-cases.json)로 고정한다.
// server.ts 가 이 모듈을 import 한다.

const DEPT_MAX_NAME_LEN = 40;          // 문자열당 최대 길이(부서명·팀명·매핑 raw·dept 공통)
const DEPT_MAX_CUSTOM_DEPTS = 30;      // customDepts 최대 개수
const DEPT_MAX_CUSTOM_TEAMS = 60;      // customTeams 최대 개수(본부 → 팀 계층)
const DEPT_MAX_CUSTOM_MAPPINGS = 60;   // customMappings 최대 개수
// 표준 6본부 — 추가만 가능, 삭제 불가. 커스텀 부서 중 이름이 겹치면 버린다.
const DEPT_STD_DEPTS = ['CB본부', 'ICT본부', '경영본부', '법무실', '고객솔루션본부', '사업성장본부'] as const;

export type DeptMapping = { raw: string; dept: string };
export type DeptTeam = { name: string; parent: string };
export type DeptConfig = { customDepts: string[]; customTeams: DeptTeam[]; customMappings: DeptMapping[] };

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

// 본부 → 팀 계층(board-custom.js sanitizeTeams 와 동일 규칙). depts는 이미 sanitizeDepts를 거친
// customDepts 목록 — parent가 표준 본부·customDepts 어디에도 없으면 소속 미정으로 강등한다.
// 팀명이 본부명과 겹치면 버린다.
function sanitizeTeams(arr: unknown, depts: string[]): DeptTeam[] {
  if (!Array.isArray(arr)) return [];
  const deptSet = new Set<string>([...DEPT_STD_DEPTS, ...depts]);
  const seen = new Set<string>();
  const out: DeptTeam[] = [];
  for (let i = 0; i < arr.length && out.length < DEPT_MAX_CUSTOM_TEAMS; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const name = sanitizeDeptName(rec.name);
    if (!name || deptSet.has(name) || seen.has(name)) continue;
    let parent = sanitizeDeptName(rec.parent);
    if (parent && !deptSet.has(parent)) parent = '';
    seen.add(name);
    out.push({ name, parent });
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

// 방어적 정규화(순수). 항상 {customDepts:[], customTeams:[], customMappings:[]} 모양을 반환한다.
export function sanitizeDeptConfig(config: unknown): DeptConfig {
  const src = (config && typeof config === 'object' && !Array.isArray(config))
    ? (config as Record<string, unknown>) : {};
  const depts = sanitizeDepts(src.customDepts);
  return {
    customDepts: depts,
    customTeams: sanitizeTeams(src.customTeams, depts),
    customMappings: sanitizeMappings(src.customMappings)
  };
}

// customTeams → "본부 소속(팀, 팀); 소속 미정(팀)" 한 줄 요약. teams는 이미 sanitize를 거친 배열.
function teamsLine(teams: DeptTeam[]): string {
  const byParent: Record<string, string[]> = {};
  const order: string[] = [];
  const unassigned: string[] = [];
  for (const t of teams) {
    if (t.parent) {
      if (!byParent[t.parent]) { byParent[t.parent] = []; order.push(t.parent); }
      byParent[t.parent].push(t.name);
    } else {
      unassigned.push(t.name);
    }
  }
  const parts = order.map(p => `${p} 소속(${byParent[p].join(', ')})`);
  if (unassigned.length) parts.push(`소속 미정(${unassigned.join(', ')})`);
  return parts.join('; ');
}

// 설정 → 프롬프트 블록(board-custom.js deptConfigToPrompt 과 문구·형식 동일, 팀 계층 포함). 비어 있으면 ''.
export function deptConfigToPrompt(config: unknown): string {
  const c = sanitizeDeptConfig(config);
  if (!c.customDepts.length && !c.customTeams.length && !c.customMappings.length) return '';
  const lines = ['[사용자 추가 부서 — 표준 본부와 동일하게 취급]'];
  if (c.customDepts.length) lines.push('- 추가 부서: ' + c.customDepts.join(', '));
  if (c.customTeams.length) lines.push('- 등록된 팀: ' + teamsLine(c.customTeams));
  if (c.customMappings.length) {
    lines.push('- 매핑(우선 적용): ' + c.customMappings.map(m => `"${m.raw}"→${m.dept}`).join(', '));
  }
  lines.push('표준 6본부 + 위 추가 부서를 모두 사용 가능. 매핑 규칙을 표준화보다 우선한다.');
  if (c.customTeams.length) lines.push('등록된 팀은 원문에 나오면 그 팀명을 그대로 dept 값에 쓴다(소속 본부가 있으면 "본부명(팀명)" 형식).');
  return lines.join('\n');
}

// AGENT.md 뒤에 이어붙일 블록. 앞에 '\n\n'을 포함(비면 ''). deptConfig 가 없거나 이상해도
// 예외를 절대 밖으로 내지 않는다 — 러너가 이 때문에 500을 내면 안 된다(설계 5절).
export function deptPromptBlock(deptConfig: unknown): string {
  try {
    const text = deptConfigToPrompt(deptConfig);
    return text ? '\n\n' + text : '';
  } catch {
    return '';
  }
}
