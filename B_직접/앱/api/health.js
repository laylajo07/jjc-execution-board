/* 조정치 · 자동 모드 감지용 헬스체크. 클라이언트 probeRunner()는 HTTP status(r.ok)만
   보고 JSON 바디는 안 읽으므로, OPENAI_API_KEY가 없을 땐 200이 아니라 503을 내야
   "자동 모드를 켤 수 없습니다" 안내가 실제로 뜬다(그냥 200+ok:false로는 안 걸러짐). */
module.exports = (req, res) => {
  const hasKey = !!process.env.OPENAI_API_KEY;
  res.statusCode = hasKey ? 200 : 503;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: hasKey, approach: 'B_직접(Vercel)' }));
};
