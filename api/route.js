// POST /api/route
// body: { start: {lat,lng}, stops: [{lat,lng,...}, ...] }
// 오픈스트리트맵 기반의 무료 공개 경로 엔진(OSRM)의 "trip" 서비스로
// 실제 도로망 기준 최단 방문 순서를 계산합니다. (별도 키 필요 없음)
//
// 참고: router.project-osrm.org 는 공개 데모 서버라 상업적 대량 트래픽에는
// 적합하지 않습니다. 개인이 하루 몇 번 쓰는 용도로는 충분합니다.

function coordStr(points) {
  return points.map(function (p) { return p.lng + ',' + p.lat; }).join(';');
}

async function osrmGet(url) {
  const r = await fetch(url);
  return r.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const returnToStart = body.returnToStart !== false;

  try {
    // ---------- mode: pinnedMulti ----------
    // 사용자가 화면에서 배달처 하나 이상을 원하는 위치로 옮겼을 때 사용.
    // 옮긴 곳들(pinned, 순서대로)은 그 자리에 그대로 고정하고, 그 사이사이/앞뒤에 남은
    // 배달처들(segments)은 각 구간(출발지→pin1, pin1→pin2, ..., 마지막pin→(복귀시 출발지))
    // 안에서 실제 도로거리 기준 최적 순서로 다시 계산합니다.
    // body: { mode:'pinnedMulti', start, pinned:[p1,p2,...], segments:[[...],[...],...(pinned.length+1개)], returnToStart }
    if (body.mode === 'pinnedMulti') {
      const start = body.start;
      const pinned = Array.isArray(body.pinned) ? body.pinned : [];
      const segments = Array.isArray(body.segments) ? body.segments : [];

      if (!start || typeof start.lat !== 'number' || typeof start.lng !== 'number') {
        return res.status(400).json({ error: 'missing_start' });
      }
      if (!pinned.length || segments.length !== pinned.length + 1) {
        return res.status(400).json({ error: 'bad_params' });
      }

      // fromPt -> (floats 최적순서) -> toPt : 양끝 고정, 가운데만 최적화
      async function optimizeBounded(fromPt, floats, toPt) {
        if (!floats.length) {
          const d = await osrmGet('https://router.project-osrm.org/route/v1/driving/' +
            coordStr([fromPt, toPt]) + '?steps=false&overview=false');
          if (d.code !== 'Ok') throw new Error(d.code);
          return { order: [], legs: d.routes[0].legs.map(function (l) { return { distanceM: l.distance, durationS: l.duration }; }) };
        }
        const pts = [fromPt].concat(floats).concat([toPt]);
        const d = await osrmGet('https://router.project-osrm.org/trip/v1/driving/' + coordStr(pts) +
          '?source=first&destination=last&roundtrip=false&steps=false&overview=false');
        if (d.code !== 'Ok') throw new Error(d.code);
        const lastIdx = pts.length - 1;
        const order = d.waypoints
          .map(function (w, i) { return { inputIndex: i, tripIndex: w.waypoint_index }; })
          .filter(function (w) { return w.inputIndex !== 0 && w.inputIndex !== lastIdx; })
          .sort(function (a, b) { return a.tripIndex - b.tripIndex; })
          .map(function (w) { return floats[w.inputIndex - 1]; });
        return { order: order, legs: d.trips[0].legs.map(function (l) { return { distanceM: l.distance, durationS: l.duration }; }) };
      }

      // fromPt -> (floats 최적순서), 끝은 고정하지 않음 (복귀 안 하는 경우 마지막 구간용)
      async function optimizeOpen(fromPt, floats) {
        if (!floats.length) return { order: [], legs: [] };
        const pts = [fromPt].concat(floats);
        const d = await osrmGet('https://router.project-osrm.org/trip/v1/driving/' + coordStr(pts) +
          '?source=first&roundtrip=false&steps=false&overview=false');
        if (d.code !== 'Ok') throw new Error(d.code);
        const order = d.waypoints
          .map(function (w, i) { return { inputIndex: i, tripIndex: w.waypoint_index }; })
          .filter(function (w) { return w.inputIndex !== 0; })
          .sort(function (a, b) { return a.tripIndex - b.tripIndex; })
          .map(function (w) { return floats[w.inputIndex - 1]; });
        return { order: order, legs: d.trips[0].legs.map(function (l) { return { distanceM: l.distance, durationS: l.duration }; }) };
      }

      try {
        const segmentsOrder = [];
        const scheduleLegs = [];
        let totalDistanceM = 0, totalDurationS = 0;

        // 고정된 지점들 사이 구간들 (출발지→pin1, pin1→pin2, ...)
        for (let i = 0; i < pinned.length; i++) {
          const fromPt = i === 0 ? start : pinned[i - 1];
          const seg = await optimizeBounded(fromPt, segments[i], pinned[i]);
          segmentsOrder.push(seg.order);
          scheduleLegs.push.apply(scheduleLegs, seg.legs); // 마지막 leg가 pin[i] 도착에 해당
          seg.legs.forEach(function (l) { totalDistanceM += l.distanceM; totalDurationS += l.durationS; });
        }

        // 마지막 고정 지점 이후 구간 (마지막pin -> 나머지 -> 복귀 or 자유종료)
        const lastFloats = segments[segments.length - 1];
        const lastAnchor = pinned.length ? pinned[pinned.length - 1] : start;
        if (returnToStart) {
          const seg = await optimizeBounded(lastAnchor, lastFloats, start);
          segmentsOrder.push(seg.order);
          // 마지막 leg는 출발지로 복귀하는 leg라 특정 배달처 도착이 아니므로 스케줄에서 제외, 총합에는 포함
          scheduleLegs.push.apply(scheduleLegs, seg.legs.slice(0, lastFloats.length));
          seg.legs.forEach(function (l) { totalDistanceM += l.distanceM; totalDurationS += l.durationS; });
        } else {
          const seg = await optimizeOpen(lastAnchor, lastFloats);
          segmentsOrder.push(seg.order);
          scheduleLegs.push.apply(scheduleLegs, seg.legs);
          seg.legs.forEach(function (l) { totalDistanceM += l.distanceM; totalDurationS += l.durationS; });
        }

        return res.status(200).json({
          segmentsOrder: segmentsOrder, legs: scheduleLegs,
          totalDistanceM: totalDistanceM, totalDurationS: totalDurationS
        });
      } catch (e) {
        return res.status(502).json({ error: 'osrm_error', message: String(e && e.message || e) });
      }
    }

    const start = body.start;
    const stops = Array.isArray(body.stops) ? body.stops : [];
    // fixedOrder: true면 순서를 다시 최적화하지 않고, 전달받은 stops 순서 그대로
    // 구간별 실제 거리/시간만 다시 계산합니다.
    const fixedOrder = !!body.fixedOrder;

    if (!start || typeof start.lat !== 'number' || typeof start.lng !== 'number') {
      return res.status(400).json({ error: 'missing_start' });
    }
    if (!stops.length) {
      return res.status(400).json({ error: 'missing_stops' });
    }

    const points = [start].concat(stops);

    // ---------- mode: fixedOrder ----------
    if (fixedOrder) {
      const routePoints = returnToStart ? points.concat([start]) : points;
      const d = await osrmGet('https://router.project-osrm.org/route/v1/driving/' + coordStr(routePoints) +
        '?steps=false&overview=false');
      if (d.code !== 'Ok') {
        return res.status(502).json({ error: 'osrm_error', detail: d.code, message: d.message || '' });
      }
      const route = d.routes[0];
      const legs = (route.legs || []).map(function (leg) { return { distanceM: leg.distance, durationS: leg.duration }; });
      return res.status(200).json({ order: stops, legs: legs, totalDistanceM: route.distance, totalDurationS: route.duration });
    }

    // ---------- mode: optimize (default) ----------
    const url = 'https://router.project-osrm.org/trip/v1/driving/' + coordStr(points) +
      '?source=first&roundtrip=' + (returnToStart ? 'true' : 'false') + '&steps=false&overview=false';
    const d = await osrmGet(url);

    if (d.code !== 'Ok') {
      return res.status(502).json({ error: 'osrm_error', detail: d.code, message: d.message || '' });
    }

    // waypoints[]는 입력 순서(start=0, stops=1..n)와 매핑되고,
    // 각 항목의 waypoint_index가 최적 방문 순서(0=출발지)를 알려줍니다.
    const ordered = d.waypoints
      .map(function (w, i) { return { inputIndex: i, tripIndex: w.waypoint_index }; })
      .filter(function (w) { return w.inputIndex !== 0; })
      .sort(function (a, b) { return a.tripIndex - b.tripIndex; })
      .map(function (w) { return stops[w.inputIndex - 1]; });

    const trip = d.trips[0];
    const legs = (trip.legs || []).map(function (leg) { return { distanceM: leg.distance, durationS: leg.duration }; });

    return res.status(200).json({ order: ordered, legs: legs, totalDistanceM: trip.distance, totalDurationS: trip.duration });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e) });
  }
};
