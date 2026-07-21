/* 조정치 · 프로젝트 히스토리 — 프로젝트/회차 상태를 다루는 순수 변환 + 얇은 localStorage 헬퍼.
   순수(DOM 접근 없음; loadProjects/saveProjects만 브라우저 스토리지를 씀). 그 외 모든 함수는
   입력 state·round를 변형하지 않고 새 state를 반환한다. file:// 더블클릭 지원을 위해 클래식 스크립트.
   A·B 바이트 동일. 설계: docs/superpowers/specs/2026-07-21-프로젝트-히스토리-design.md §1-2. */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'jjc-projects';
  var MAX_PROJECT_NAME_LEN = 40;
  var MAX_ROUND_TITLE_LEN = 120;
  var MAX_ROUNDS = 20; // 회차 상한 — 초과 시 오래된 것부터 제거(설계 1절)

  // 제어문자·개행을 공백으로 치환 → 연속 공백 접기 → trim → 코드포인트 단위 길이 컷.
  // (board-custom.js sanitizeName과 동일 관심사·동일 알고리즘 — 이 모듈은 독립 파일이라 로컬 복제한다.)
  function cleanText(s, maxLen) {
    if (typeof s !== 'string') return '';
    var cleaned = s.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim();
    var codePoints = Array.from(cleaned);
    if (codePoints.length > maxLen) cleaned = codePoints.slice(0, maxLen).join('').trim();
    return cleaned;
  }

  function sanitizeProjectName(s) { return cleanText(s, MAX_PROJECT_NAME_LEN); }
  function sanitizeRoundTitle(s) { return cleanText(s, MAX_ROUND_TITLE_LEN); }

  // 기존 id들 중 prefix로 시작하는 것의 최대 숫자 접미사 + 1. Date.now()/Math.random() 없이
  // state에 이미 있는 id만으로 다음 id를 결정적으로 뽑는다(테스트 재현성).
  function nextSeqId(ids, prefix) {
    var max = 0, i, n;
    for (i = 0; i < ids.length; i++) {
      if (typeof ids[i] !== 'string' || ids[i].slice(0, prefix.length) !== prefix) continue;
      n = Number(ids[i].slice(prefix.length));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return prefix + (max + 1);
  }

  // ts는 raw.updated_at(있으면) 또는 저장 시각(설계 1절). raw.updated_at은 보드 데이터가 이미
  // 들고 있는 문자열을 그대로 신뢰하고, 없을 때만 현재 시각으로 대체한다.
  function pickTs(raw) {
    if (raw && typeof raw === 'object' && typeof raw.updated_at === 'string' && raw.updated_at.trim()) {
      return raw.updated_at.trim();
    }
    return new Date().toISOString();
  }

  function sanitizeRound(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    var id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) return null;
    return {
      id: id,
      ts: typeof r.ts === 'string' ? r.ts : '',
      title: sanitizeRoundTitle(r.title),
      raw: (r.raw === undefined) ? null : r.raw
    };
  }

  function sanitizeProject(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    var id = typeof p.id === 'string' ? p.id.trim() : '';
    if (!id) return null;
    var roundsSrc = Array.isArray(p.rounds) ? p.rounds : [];
    var seen = Object.create(null), rounds = [], i, r;
    for (i = 0; i < roundsSrc.length; i++) {
      r = sanitizeRound(roundsSrc[i]);
      if (!r || seen[r.id]) continue;
      seen[r.id] = true;
      rounds.push(r);
    }
    if (rounds.length > MAX_ROUNDS) rounds = rounds.slice(rounds.length - MAX_ROUNDS);
    return {
      id: id,
      name: sanitizeProjectName(p.name),
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
      rounds: rounds
    };
  }

  // 방어적 정규화(순수 — 입력을 변형하지 않는다). 항상 {current, projects:[]} 형태를 반환하고,
  // current가 남아있는 프로젝트를 가리키지 않으면 ''로 되돌린다. 모든 공개 함수가 진입점에서
  // 이걸 거쳐 기형 state가 들어와도 던지지 않고 일관된 모양으로 동작한다.
  function sanitize(state) {
    var src = (state && typeof state === 'object' && !Array.isArray(state)) ? state : {};
    var projectsSrc = Array.isArray(src.projects) ? src.projects : [];
    var seen = Object.create(null), projects = [], i, p;
    for (i = 0; i < projectsSrc.length; i++) {
      p = sanitizeProject(projectsSrc[i]);
      if (!p || seen[p.id]) continue;
      seen[p.id] = true;
      projects.push(p);
    }
    var current = typeof src.current === 'string' ? src.current : '';
    if (current && !seen[current]) current = '';
    return { current: current, projects: projects };
  }

  // localStorage 읽기 + sanitize. 부재·파싱 실패·환경 없음 시 빈 state(예외 없음).
  function loadProjects() {
    if (typeof localStorage === 'undefined') return sanitize(null);
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? sanitize(JSON.parse(raw)) : sanitize(null);
    } catch (e) {
      return sanitize(null);
    }
  }

  // sanitize 후 저장. 성공 true / 실패(환경 없음·quota·차단) false(예외 없음).
  function saveProjects(state) {
    if (typeof localStorage === 'undefined') return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitize(state)));
      return true;
    } catch (e) {
      return false;
    }
  }

  // 불변: 새 프로젝트를 추가하고 current를 그 프로젝트로 설정한다.
  function createProject(state, name) {
    var s = sanitize(state);
    var id = nextSeqId(s.projects.map(function (p) { return p.id; }), 'p_');
    var project = { id: id, name: sanitizeProjectName(name), createdAt: new Date().toISOString(), rounds: [] };
    return { state: { current: id, projects: s.projects.concat([project]) }, id: id };
  }

  function renameProject(state, id, name) {
    var s = sanitize(state);
    var newName = sanitizeProjectName(name);
    var projects = s.projects.map(function (p) {
      if (p.id !== id) return p;
      return { id: p.id, name: newName, createdAt: p.createdAt, rounds: p.rounds };
    });
    return { current: s.current, projects: projects };
  }

  // 프로젝트 제거. current였다면 sanitize가 되돌려 ''로 초기화한다.
  function deleteProject(state, id) {
    var s = sanitize(state);
    var projects = s.projects.filter(function (p) { return p.id !== id; });
    return sanitize({ current: s.current, projects: projects });
  }

  // 해당 프로젝트의 rounds 뒤에 회차를 추가한다. id·ts는 이 함수가 채운다(호출자는 title·raw만 준다).
  // 20개 초과 시 오래된 것부터 제거. projectId가 없으면 아무 것도 바꾸지 않는다(no-op).
  function addRound(state, projectId, round) {
    var s = sanitize(state);
    var r = (round && typeof round === 'object' && !Array.isArray(round)) ? round : {};
    var raw = (r.raw === undefined) ? null : r.raw;
    var found = false;
    var projects = s.projects.map(function (p) {
      if (p.id !== projectId) return p;
      found = true;
      var rid = nextSeqId(p.rounds.map(function (x) { return x.id; }), 'r_');
      var newRound = { id: rid, ts: pickTs(raw), title: sanitizeRoundTitle(r.title), raw: raw };
      var rounds = p.rounds.concat([newRound]);
      if (rounds.length > MAX_ROUNDS) rounds = rounds.slice(rounds.length - MAX_ROUNDS);
      return { id: p.id, name: p.name, createdAt: p.createdAt, rounds: rounds };
    });
    return { current: s.current, projects: found ? projects : s.projects };
  }

  // current를 바꾼다. ''는 선택 해제. 존재하지 않는 id는 무시하고 기존 current를 유지한다.
  function setCurrent(state, id) {
    var s = sanitize(state);
    var ok = id === '' || s.projects.some(function (p) { return p.id === id; });
    return { current: ok ? id : s.current, projects: s.projects };
  }

  function getProject(state, id) {
    var s = sanitize(state);
    for (var i = 0; i < s.projects.length; i++) {
      if (s.projects[i].id === id) return s.projects[i];
    }
    return null;
  }

  var api = {
    loadProjects: loadProjects,
    saveProjects: saveProjects,
    createProject: createProject,
    renameProject: renameProject,
    deleteProject: deleteProject,
    addRound: addRound,
    setCurrent: setCurrent,
    getProject: getProject,
    sanitize: sanitize
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ProjectStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
