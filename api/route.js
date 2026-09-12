// POST /api/route
// body: { start: {lat,lng}, stops: [{lat,lng,...}, ...] }
// 오픈스트리트맵 기반의 무료 공개 경로 엔진(OSRM)의 "trip" 서비스로
// 실제 도로망 기준 최단 방문 순서를 계산합니다. (별도 키 필요 없음)
//
// 참고: router.project-osrm.org 는 공개 데모 서버라 상업적 대량 트래픽에는
// 적합하지 않습니다. 개인이 하루 몇 번 쓰는 용도로는 충분합니다.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  const start = body && body.start;
  const stops = (body && Array.isArray(body.stops)) ? body.stops : [];

  if (!start || typeof start.lat !== 'number' || typeof start.lng !== 'number') {
    return res.status(400).json({ error: 'missing_start' });
  }
  if (!stops.length) {
    return res.status(400).json({ error: 'missing_stops' });
  }

  const points = [start].concat(stops);
  const coordStr = points.map(function (p) { return p.lng + ',' + p.lat; }).join(';');
  const url = 'https://router.project-osrm.org/trip/v1/driving/' + coordStr +
    '?source=first&roundtrip=false&steps=false&overview=false';

  try {
    const r = await fetch(url);
    const data = await r.json();

    if (data.code !== 'Ok') {
      return res.status(502).json({ error: 'osrm_error', detail: data.code, message: data.message || '' });
    }

    // waypoints[]는 입력 순서(start=0, stops=1..n)와 매핑되고,
    // 각 항목의 waypoint_index가 최적 방문 순서(0=출발지)를 알려줍니다.
    const wps = data.waypoints;
    const ordered = wps
      .map(function (w, i) { return { inputIndex: i, tripIndex: w.waypoint_index }; })
      .filter(function (w) { return w.inputIndex !== 0; })
      .sort(function (a, b) { return a.tripIndex - b.tripIndex; })
      .map(function (w) { return stops[w.inputIndex - 1]; });

    const trip = data.trips[0];
    // legs[i]는 (i)번째 지점에서 (i+1)번째 지점까지 구간 정보 (출발지 포함, 방문순서 기준)
    const legs = (trip.legs || []).map(function (leg) {
      return { distanceM: leg.distance, durationS: leg.duration };
    });

    return res.status(200).json({
      order: ordered,
      legs: legs,
      totalDistanceM: trip.distance,
      totalDurationS: trip.duration
    });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e) });
  }
};
