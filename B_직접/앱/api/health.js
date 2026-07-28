/* 조정치 · 자동 모드 감지용 헬스체크. 클라이언트 probeRunner()는 HTTP status(r.ok)만
   보고 JSON 바디는 안 읽으므로, OPENAI_API_KEY가 없을 땐 200이 아니라 503을 내야
   "자동 모드를 켤 수 없습니다" 안내가 실제로 뜬다(그냥 200+ok:false로는 안 걸러짐).

   임시 진단 필드(near): OPENAI_API_KEY가 없을 때 이름에 OPENAI/API/KEY가 들어간
   다른 환경변수 "이름"만 보여준다(값은 절대 노출 안 함) — 변수명 오타·다른 이름으로
   등록된 경우를 원인 규명 후 제거할 것. */
module.exports = (req, res) => {
  const hasKey = !!process.env.OPENAI_API_KEY;
  res.statusCode = hasKey ? 200 : 503;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const body = { ok: hasKey, approach: 'B_직접(Vercel)' };
  if (!hasKey) {
    body.near = Object.keys(process.env).filter(function (k) {
      return /OPENAI|API|KEY/i.test(k);
    });
  }
  res.end(JSON.stringify(body));
};
