/* 조정치 · Vercel 배포용 회의록 목록 — 로컬 러너는 실행하는 컴퓨터의 회의록/ 폴더를 읽지만,
   서버리스엔 그런 사용자 폴더가 없다. 대신 저장소에 커밋된 B_직접/앱/샘플/ 을 읽어
   데모용 회의록 몇 개를 보여준다. 이 폴더에 .md/.txt 파일을 추가·수정하고 git push하면
   그대로 드롭다운에 반영된다(재배포 필요) — 소유자가 직접 내용을 관리하는 지점. */
const fs = require('fs');
const path = require('path');

const SAMPLE_DIR = path.join(process.cwd(), '샘플');

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  let items = [];
  try {
    items = fs.readdirSync(SAMPLE_DIR)
      .filter(function (n) { return /\.(md|txt)$/i.test(n); })
      .sort()
      .map(function (n) { return { name: n }; });
  } catch (e) { items = []; }
  res.statusCode = 200;
  res.end(JSON.stringify(items));
};
