// /api/geocode?q=주소 또는 이름
// 카카오 로컬 API로 주소(또는 장소명)를 위도/경도로 변환합니다.
// 카카오 REST API 키는 Vercel 프로젝트의 환경변수 KAKAO_REST_KEY 에 저장해서 사용합니다.
// (코드에 키를 직접 넣지 않기 때문에, 이 프론트엔드/깃허브 코드에는 키가 노출되지 않습니다.)

module.exports = async (req, res) => {
  const key = process.env.KAKAO_REST_KEY;
  const q = (req.query.q || '').toString().trim();

  if (!key) {
    return res.status(500).json({ error: 'missing_key', message: 'Vercel 환경변수 KAKAO_REST_KEY 가 설정되지 않았습니다.' });
  }
  if (!q) {
    return res.status(400).json({ error: 'missing_query', message: 'q 파라미터(주소 또는 이름)가 필요합니다.' });
  }

  try {
    // 1) 정확한 주소 검색
    let r = await fetch('https://dapi.kakao.com/v2/local/search/address.json?query=' + encodeURIComponent(q), {
      headers: { Authorization: 'KakaoAK ' + key }
    });
    let data = await r.json();
    if (data.documents && data.documents.length) {
      const d = data.documents[0];
      return res.status(200).json({
        lat: parseFloat(d.y),
        lng: parseFloat(d.x),
        matched: d.address_name,
        source: 'address'
      });
    }

    // 2) 주소로 못 찾으면 장소명(상호명) 검색으로 재시도
    r = await fetch('https://dapi.kakao.com/v2/local/search/keyword.json?query=' + encodeURIComponent(q), {
      headers: { Authorization: 'KakaoAK ' + key }
    });
    data = await r.json();
    if (data.documents && data.documents.length) {
      const d = data.documents[0];
      return res.status(200).json({
        lat: parseFloat(d.y),
        lng: parseFloat(d.x),
        matched: d.place_name,
        source: 'keyword'
      });
    }

    return res.status(404).json({ error: 'not_found', message: '주소를 찾을 수 없습니다. 주소를 더 정확히 입력해보세요.' });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e) });
  }
};
