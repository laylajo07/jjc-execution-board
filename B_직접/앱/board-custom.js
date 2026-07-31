/* 조정치 · 부서 커스터마이징 — 사용자 설정(customDepts/customTeams/customMappings) → 프롬프트 블록 +
   localStorage 저장. customTeams: 본부(표준 6본부 또는 customDepts) 아래 소속되거나(parent) 소속 미정으로
   독립 등록되는 "팀" 계층(사용자 요청). 순수(DOM 접근 없음; load/save만 브라우저 스토리지를 씀).
   file:// 더블클릭 지원을 위해 클래식 스크립트. A·B 바이트 동일. 보드 표시 유틸(fmtUpdatedAt 등)도 이 모듈이 겸한다. */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'jjc-dept-config';
  var MAX_NAME_LEN = 40;         // 문자열 1개(부서명·팀명·raw·dept)당 최대 길이
  var MAX_CUSTOM_DEPTS = 30;     // customDepts 최대 개수
  var MAX_CUSTOM_TEAMS = 60;     // customTeams 최대 개수
  var MAX_CUSTOM_MAPPINGS = 60;  // customMappings 최대 개수

  // 표준 6본부 — 추가만 가능, 삭제 불가(설계 7절). 동결해 호출자가 못 망가뜨리게 한다.
  var STD_DEPTS = Object.freeze(['CB본부', 'ICT본부', '경영본부', '법무실', '고객솔루션본부', '사업성장본부']);

  // LLM 프롬프트에 그대로 들어가는 값이므로 정규화가 곧 보안 경계다.
  // 제어문자·개행(\r,\n,\t 등 C0/C1)을 공백으로 치환 → 연속 공백 접기 → trim → 길이 컷.
  function sanitizeName(s) {
    if (typeof s !== 'string') return '';
    var cleaned = s.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim();
    // 코드 포인트 단위로 자른다(.slice(0,N)은 UTF-16 코드 유닛 단위라 서러게이트 쌍을
    // 반으로 잘라 홀로 남은 하이 서러게이트 같은 깨진 유니코드를 만들 수 있다).
    var codePoints = Array.from(cleaned);
    if (codePoints.length > MAX_NAME_LEN) cleaned = codePoints.slice(0, MAX_NAME_LEN).join('').trim();
    return cleaned;
  }

  function sanitizeDepts(arr) {
    if (!Array.isArray(arr)) return [];
    var stdSet = Object.create(null);
    STD_DEPTS.forEach(function (d) { stdSet[d] = true; });
    var seen = Object.create(null), out = [], i, name;
    for (i = 0; i < arr.length && out.length < MAX_CUSTOM_DEPTS; i++) {
      name = sanitizeName(arr[i]);
      if (!name || stdSet[name] || seen[name]) continue;
      seen[name] = true;
      out.push(name);
    }
    return out;
  }

  // 본부 → 팀 계층(사용자 요청) — 팀은 등록된 본부(표준 6본부 또는 customDepts) 중 하나에 소속되거나,
  // parent를 비워 "소속 미정" 팀으로 독립 등록될 수 있다. depts는 이미 sanitizeDepts를 거친
  // customDepts 목록 — parent가 표준 본부·customDepts 어디에도 없으면 소속 미정으로 강등한다
  // (끊긴 참조 방지). 팀명이 본부명과 겹치면 버린다(드롭다운·프롬프트에서 모호해지므로).
  function sanitizeTeams(arr, depts) {
    if (!Array.isArray(arr)) return [];
    var deptSet = Object.create(null);
    STD_DEPTS.forEach(function (d) { deptSet[d] = true; });
    (depts || []).forEach(function (d) { deptSet[d] = true; });
    var seen = Object.create(null), out = [], i, item, name, parent;
    for (i = 0; i < arr.length && out.length < MAX_CUSTOM_TEAMS; i++) {
      item = arr[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      name = sanitizeName(item.name);
      if (!name || deptSet[name] || seen[name]) continue;
      parent = sanitizeName(item.parent);
      if (parent && !deptSet[parent]) parent = '';
      seen[name] = true;
      out.push({ name: name, parent: parent });
    }
    return out;
  }

  function sanitizeMappings(arr) {
    if (!Array.isArray(arr)) return [];
    var seenRaw = Object.create(null), out = [], i, m, raw, dept;
    for (i = 0; i < arr.length && out.length < MAX_CUSTOM_MAPPINGS; i++) {
      m = arr[i];
      if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
      raw = sanitizeName(m.raw);
      dept = sanitizeName(m.dept);
      if (!raw || !dept || seenRaw[raw]) continue;
      seenRaw[raw] = true;
      out.push({ raw: raw, dept: dept });
    }
    return out;
  }

  // 방어적 정규화(순수 — 입력을 변형하지 않는다). 항상 {customDepts:[], customTeams:[], customMappings:[]}를 반환한다.
  function sanitize(config) {
    var src = (config && typeof config === 'object' && !Array.isArray(config)) ? config : {};
    var depts = sanitizeDepts(src.customDepts);
    return {
      customDepts: depts,
      customTeams: sanitizeTeams(src.customTeams, depts),
      customMappings: sanitizeMappings(src.customMappings)
    };
  }

  // customTeams → "본부 소속(팀, 팀); 소속 미정(팀)" 한 줄 요약. teams는 이미 sanitize를 거친 배열.
  function teamsLine(teams) {
    var byParent = Object.create(null), order = [], unassigned = [], i, t;
    for (i = 0; i < teams.length; i++) {
      t = teams[i];
      if (t.parent) {
        if (!byParent[t.parent]) { byParent[t.parent] = []; order.push(t.parent); }
        byParent[t.parent].push(t.name);
      } else {
        unassigned.push(t.name);
      }
    }
    var parts = order.map(function (p) { return p + ' 소속(' + byParent[p].join(', ') + ')'; });
    if (unassigned.length) parts.push('소속 미정(' + unassigned.join(', ') + ')');
    return parts.join('; ');
  }

  // 설정 → 프롬프트 블록(설계 1-3, 문구 고정. 팀 계층은 사용자 요청으로 추가). 비어 있으면 ''.
  // 앞뒤 개행 없이 블록만 반환 — 호출자가 '\n\n'으로 이어붙인다.
  function deptConfigToPrompt(config) {
    var c = sanitize(config);
    if (!c.customDepts.length && !c.customTeams.length && !c.customMappings.length) return '';
    var lines = ['[사용자 추가 부서 — 표준 본부와 동일하게 취급]'];
    if (c.customDepts.length) lines.push('- 추가 부서: ' + c.customDepts.join(', '));
    if (c.customTeams.length) lines.push('- 등록된 팀: ' + teamsLine(c.customTeams));
    if (c.customMappings.length) {
      lines.push('- 매핑(우선 적용): ' + c.customMappings.map(function (m) {
        return '"' + m.raw + '"→' + m.dept;
      }).join(', '));
    }
    lines.push('표준 6본부 + 위 추가 부서를 모두 사용 가능. 매핑 규칙을 표준화보다 우선한다.');
    // 신뢰도 버그 수정(사용자 요청): 등록된 팀은 원문 그대로의 팀명을 dept 값으로 쓰게 해
    // 임의로 상위 본부명에 뭉개 넣지 않도록 한다(예: "영업팀"이 "고객솔루션본부"로만 표시되던 문제).
    if (c.customTeams.length) lines.push('등록된 팀은 원문에 나오면 그 팀명을 그대로 dept 값에 쓴다(소속 본부가 있으면 "본부명(팀명)" 형식).');
    return lines.join('\n');
  }

  // localStorage 읽기 + sanitize. 부재·파싱 실패·환경 없음 시 빈 config(예외 없음).
  function load() {
    if (typeof localStorage === 'undefined') return sanitize(null);
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? sanitize(JSON.parse(raw)) : sanitize(null);
    } catch (e) {
      return sanitize(null);
    }
  }

  // sanitize 후 저장. 성공 true / 실패(환경 없음·quota·차단) false(예외 없음).
  function save(config) {
    if (typeof localStorage === 'undefined') return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitize(config)));
      return true;
    } catch (e) {
      return false;
    }
  }

  // 2자리 zero-pad(시·분 전용). 월·일은 pad하지 않는다(명세).
  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  // 보드 업데이트 일시 → 한글 표시 문자열. 로컬 tz 게터 사용(뷰어 로컬 시각).
  // "{YYYY}년 {M}월 {D}일 ({요일}) {HH}:{MM}" — 연 4자리, 월·일 no-pad, 시·분 2자리 pad.
  // 방어: Date가 아니거나 Invalid Date/null/undefined면 '' (예외를 던지지 않는다).
  function fmtUpdatedAt(date) {
    // toString 태그로 진짜 Date인지 확인(instanceof는 프로토타입만 봐서 스푸핑된 가짜가 getTime에서 던짐).
    if (Object.prototype.toString.call(date) !== '[object Date]' || Number.isNaN(date.getTime())) return '';
    var weekday = ['일', '월', '화', '수', '목', '금', '토'][date.getDay()];
    return date.getFullYear() + '년 ' + (date.getMonth() + 1) + '월 ' + date.getDate() + '일 (' +
      weekday + ') ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  var api = {
    STD_DEPTS: STD_DEPTS,
    sanitize: sanitize,
    deptConfigToPrompt: deptConfigToPrompt,
    load: load,
    save: save,
    fmtUpdatedAt: fmtUpdatedAt
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BoardCustom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
