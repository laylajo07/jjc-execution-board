/* 조정치 · Vercel 배포용 회의록 본문 — notes.js가 나열한 B_직접/앱/샘플/ 파일 하나를 읽어
   돌려준다. name은 path.basename으로 걸러 경로 이탈(../ 등)을 막는다. */
const fs = require('fs');
const path = require('path');

const SAMPLE_DIR = path.join(process.cwd(), '샘플');

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const url = new URL(req.url, 'http://x');
  const name = path.basename(url.searchParams.get('name') || '');
  if (!name) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'name required' })); }
  const fp = path.join(SAMPLE_DIR, name);
  try {
    const content = fs.readFileSync(fp, 'utf-8');
    res.statusCode = 200;
    res.end(JSON.stringify({ name: name, content: content }));
  } catch (e) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  }
};
