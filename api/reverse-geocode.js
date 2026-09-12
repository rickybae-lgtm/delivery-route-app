// /api/reverse-geocode?lat=..&lng=..
// 좌표(위도/경도)를 주소로 변환합니다 (카카오 로컬 API 좌표->주소 변환).
// "현재 위치 사용" 버튼에서, GPS로 얻은 좌표에 해당하는 주소를 자동으로 채워주는 용도.

module.exports = async (req, res) => {
  const key = process.env.KAKAO_REST_KEY;
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  if (!key) {
    return res.status(500).json({ error: 'missing_key', message: 'Vercel 환경변수 KAKAO_REST_KEY 가 설정되지 않았습니다.' });
  }
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'missing_query', message: 'lat, lng 파라미터가 필요합니다.' });
  }

  try {
    const r = await fetch(
      'https://dapi.kakao.com/v2/local/geo/coord2address.json?x=' + lng + '&y=' + lat,
      { headers: { Authorization: 'KakaoAK ' + key } }
    );
    const data = await r.json();
    if (data.documents && data.documents.length) {
      const d = data.documents[0];
      const addr = (d.road_address && d.road_address.address_name) ||
        (d.address && d.address.address_name) || '';
      return res.status(200).json({ address: addr });
    }
    return res.status(404).json({ error: 'not_found', message: '이 위치의 주소를 찾을 수 없습니다.' });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e) });
  }
};
