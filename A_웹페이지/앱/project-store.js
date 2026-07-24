/* 조정치 · 프로젝트 히스토리 — 프로젝트/회차 상태를 다루는 순수 변환 + 얇은 localStorage 헬퍼.
   순수(DOM 접근 없음; loadProjects/saveProjects만 브라우저 스토리지를 씀). 그 외 모든 함수는
   입력 state·round를 변형하지 않고 새 state를 반환한다. file:// 더블클릭 지원을 위해 클래식 스크립트.
   A·B 바이트 동일. 설계: docs/superpowers/specs/2026-07-21-프로젝트-히스토리-design.md §1-2. */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'jjc-projects';
  var MAX_PROJECT_NAME_LEN = 40;
  var MAX_ROUND_TITLE_LEN = 120;
  var MAX_NOTE_ID_LEN = 200; // 회의록 식별자(파일명) 길이 컷
  var MAX_NOTE_LEN = 100000; // 회의록 원문 길이 컷(공백·개행은 보존, 길이만 제한)
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

  // raw를 깊은 복제로 떼어낸다 — 호출자가 준(또는 기존 저장된) raw 객체를 참조로 그대로 들고 있으면
  // 저장 후 호출자 쪽 변형이 상태에 새거나, 두 state가 같은 raw를 공유(alias)하게 된다. 순환 참조 등
  // JSON으로 못 도는 값이면 예외 대신 null로 대체한다(설계: 순수·무예외).
  function cloneRaw(raw) {
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(JSON.stringify(raw)); } catch (e) { return null; }
  }

  // 회의록 원문: 문자열만 통과(제어문자·개행 보존 — cleanText 금지), 길이만 컷. 아니면 빈 문자열.
  function cleanNote(s) {
    if (typeof s !== 'string') return '';
    return s.length > MAX_NOTE_LEN ? s.slice(0, MAX_NOTE_LEN) : s;
  }

  // 양의 정수로 강제(number·숫자문자열 허용). 아니면 null.
  function toPosInt(v) {
    var n;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
    else return null;
    return (Number.isFinite(n) && n >= 1 && Math.floor(n) === n) ? n : null;
  }

  // MAX_ROUNDS 초과분을 ts(처리시각) 기준으로 가장 오래된 것부터 제거한다. 배열 순번이 아니라
  // ts로 판단하는 이유: roundNo는 처리순서와 무관한 사용자 식별자(지시 16)라 재분석 등으로
  // 회차가 배열 끝이 아닌 자리에서 갱신되거나, 저장된 데이터가 어떤 경로로든 삽입순과 다르게
  // 정렬돼 있어도 "실제로 가장 오래 전에 처리된" 회차가 항상 먼저 잘리게 하기 위함이다.
  // 살아남는 회차의 상대 순서는 원래 배열 순서를 그대로 보존한다(다른 불변식에 영향 없음).
  function capRounds(rounds) {
    if (rounds.length <= MAX_ROUNDS) return rounds;
    var withIdx = rounds.map(function (r, i) { return { r: r, i: i }; });
    withIdx.sort(function (a, b) {
      var ta = a.r.ts || '', tb = b.r.ts || '';
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return a.i - b.i; // ts가 같으면(또는 둘 다 비어있으면) 원래 배열상 앞쪽을 오래된 것으로 취급
    });
    var dropCount = rounds.length - MAX_ROUNDS;
    var dropSet = Object.create(null);
    for (var k = 0; k < dropCount; k++) dropSet[withIdx[k].i] = true;
    return rounds.filter(function (r, i) { return !dropSet[i]; });
  }

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
      projectId: '',                         // sanitizeProject가 실제 소속 프로젝트 id로 강제 통일(지시 17)
      roundNo: toPosInt(r.roundNo),          // null이면 sanitizeProject가 배정
      noteId: cleanText(r.noteId, MAX_NOTE_ID_LEN),
      note: cleanNote(r.note),
      ts: typeof r.ts === 'string' ? r.ts : '',
      createdTs: typeof r.createdTs === 'string' ? r.createdTs : '',
      title: sanitizeRoundTitle(r.title),
      raw: cloneRaw(r.raw),
      baselineNo: toPosInt(r.baselineNo),
      baselineStamp: typeof r.baselineStamp === 'string' ? r.baselineStamp : ''
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
    rounds = capRounds(rounds);
    // projectId는 항상 실제 소속(이 프로젝트의 id)으로 강제 통일 — 입력값(누락·오염)은 신뢰하지 않는다(지시 17).
    for (i = 0; i < rounds.length; i++) rounds[i].projectId = id;
    // roundNo 정합: 유효·유일 값은 채택, 중복/누락/비정수는 미사용 최소 양의정수를 배열 순서대로 배정(멱등).
    var usedNo = Object.create(null), i2;
    for (i2 = 0; i2 < rounds.length; i2++) {
      var rn = rounds[i2].roundNo;
      if (rn !== null && !usedNo[rn]) usedNo[rn] = true;
      else rounds[i2].roundNo = null;
    }
    var next = 1;
    for (i2 = 0; i2 < rounds.length; i2++) {
      if (rounds[i2].roundNo === null) {
        while (usedNo[next]) next++;
        rounds[i2].roundNo = next; usedNo[next] = true;
      }
    }
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
  // raw는 깊은 복제로 떼어 저장한다(cloneRaw) — 호출자가 이후 자기 raw를 변형해도 저장된 회차는 영향받지 않는다.
  // 20개 초과 시 오래된 것부터 제거. projectId가 없으면 아무 것도 바꾸지 않는다(no-op).
  // 회차를 upsert한다. round.roundNo가 있고 이미 존재하면 교체(재분석, 같은 id 유지, ts는 새 처리시각,
  // title/raw/noteId 갱신, baseline은 null/'' 초기화 → 호출자가 재설정). 없으면 max roundNo+1로 append
  // (기존 r_N 순번·20캡 동작 유지). raw는 딥클론. projectId 없으면 no-op.
  function addRound(state, projectId, round) {
    var s = sanitize(state);
    var r = (round && typeof round === 'object' && !Array.isArray(round)) ? round : {};
    var raw = cloneRaw(r.raw);
    var noteId = cleanText(r.noteId, MAX_NOTE_ID_LEN);
    var note = cleanNote(r.note);
    var title = sanitizeRoundTitle(r.title);
    var ts = pickTs(raw);
    var argCreatedTs = (typeof r.createdTs === 'string' && r.createdTs) ? r.createdTs : null;
    var found = false;
    var projects = s.projects.map(function (p) {
      if (p.id !== projectId) return p;
      found = true;
      var maxNo = 0;
      p.rounds.forEach(function (x) { if (x.roundNo > maxNo) maxNo = x.roundNo; });
      var rn = toPosInt(r.roundNo);
      if (rn === null) rn = maxNo + 1;
      var exists = false;
      p.rounds.forEach(function (x) { if (x.roundNo === rn) exists = true; });
      var rounds;
      if (exists) {
        rounds = p.rounds.map(function (x) {
          if (x.roundNo !== rn) return x;
          // 덮어쓰기(재분석): createdTs는 최초값 보존(없으면 ts로 폴백), ts만 갱신.
          var createdTs = argCreatedTs || x.createdTs || ts;
          return { id: x.id, projectId: p.id, roundNo: rn, noteId: noteId, note: note, ts: ts, createdTs: createdTs, title: title, raw: raw, baselineNo: null, baselineStamp: '' };
        });
      } else {
        var rid = nextSeqId(p.rounds.map(function (x) { return x.id; }), 'r_');
        var newRound = { id: rid, projectId: p.id, roundNo: rn, noteId: noteId, note: note, ts: ts, createdTs: argCreatedTs || ts, title: title, raw: raw, baselineNo: null, baselineStamp: '' };
        rounds = capRounds(p.rounds.concat([newRound]));
      }
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

  function getRoundByNo(project, roundNo) {
    var rn = toPosInt(roundNo);
    var rounds = (project && Array.isArray(project.rounds)) ? project.rounds : [];
    for (var i = 0; i < rounds.length; i++) if (rounds[i].roundNo === rn) return rounds[i];
    return null;
  }

  // roundNo보다 작은 회차 중 roundNo가 최대인 회차(지시 18). 없으면 null. 처리 순서 무관.
  function findBaseline(project, roundNo) {
    var rn = toPosInt(roundNo);
    var rounds = (project && Array.isArray(project.rounds)) ? project.rounds : [];
    if (rn === null) return null;
    var best = null;
    rounds.forEach(function (r) {
      if (r.roundNo !== null && r.roundNo < rn && (!best || r.roundNo > best.roundNo)) best = r;
    });
    return best;
  }

  function roundsSortedByNo(project) {
    var rounds = (project && Array.isArray(project.rounds)) ? project.rounds.slice() : [];
    rounds.sort(function (a, b) { return a.roundNo - b.roundNo; });
    return rounds;
  }

  function roundsUsingBaseline(project, roundNo) {
    var rn = toPosInt(roundNo);
    var rounds = (project && Array.isArray(project.rounds)) ? project.rounds : [];
    return rounds.filter(function (r) { return r.baselineNo !== null && r.baselineNo === rn; });
  }

  // 정합 마커(baselineNo/baselineStamp)만 갱신하는 불변 세터.
  function setRoundBaseline(state, projectId, roundId, baselineNo, baselineStamp) {
    var s = sanitize(state);
    var bn = toPosInt(baselineNo);
    var bs = typeof baselineStamp === 'string' ? baselineStamp : '';
    var projects = s.projects.map(function (p) {
      if (p.id !== projectId) return p;
      var rounds = p.rounds.map(function (r) {
        if (r.id !== roundId) return r;
        return { id: r.id, projectId: r.projectId, roundNo: r.roundNo, noteId: r.noteId, note: r.note, ts: r.ts, createdTs: r.createdTs, title: r.title, raw: r.raw, baselineNo: bn, baselineStamp: bs };
      });
      return { id: p.id, name: p.name, createdAt: p.createdAt, rounds: rounds };
    });
    return { current: s.current, projects: projects };
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
    sanitize: sanitize,
    getRoundByNo: getRoundByNo,
    findBaseline: findBaseline,
    roundsSortedByNo: roundsSortedByNo,
    roundsUsingBaseline: roundsUsingBaseline,
    setRoundBaseline: setRoundBaseline
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ProjectStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
