/* 조정치 · Vercel 배포용 회의록 본문 — notes.js가 나열한 B_직접/앱/샘플/ 파일 하나를 읽어
   돌려준다. name은 path.basename으로 걸러 경로 이탈(../ 등)을 막는다. */
const fs = require('fs');
const path = require('path');

// notes.js와 동일한 이유로 여러 후보 경로를 시도한다(process.cwd()가 항상 프로젝트
// 루트라는 보장이 없음이 실제로 확인됨).
var CANDIDATES = [
  path.join(process.cwd(), '샘플'),
  path.join(__dirname, '..', '샘플'),
  path.join(__dirname, '샘플')
];
function findSampleDir() {
  for (var i = 0; i < CANDIDATES.length; i++) {
    try { if (fs.statSync(CANDIDATES[i]).isDirectory()) return CANDIDATES[i]; } catch (e) {}
  }
  return null;
}

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const url = new URL(req.url, 'http://x');
  const name = path.basename(url.searchParams.get('name') || '');
  if (!name) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'name required' })); }
  const dir = findSampleDir();
  if (!dir) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not found' })); }
  const fp = path.join(dir, name);
  try {
    const content = fs.readFileSync(fp, 'utf-8');
    res.statusCode = 200;
    res.end(JSON.stringify({ name: name, content: content }));
  } catch (e) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  }
};
