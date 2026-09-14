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

// ---------- 오픈시간(대기시간)을 감안한 순서 최적화용 헬퍼 ----------
// OSRM "trip" 서비스는 순수 거리/시간만 최소화할 뿐 "오픈시간에 맞춰 대기"같은 개념이 없어서,
// 여기서는 전체 지점 간 실제 이동시간표(matrix)를 한 번 받아온 뒤,
// "출발~복귀까지 걸리는 전체 시간(운전+대기+상하차)"이 최소가 되도록 직접 순서를 탐색합니다.
async function fetchTable(points) {
  const d = await osrmGet('https://router.project-osrm.org/table/v1/driving/' + coordStr(points) + '?annotations=duration,distance');
  if (d.code !== 'Ok') throw new Error(d.code);
  return { durations: d.durations, distances: d.distances };
}

// order: 방문할 지점들의 matrix 인덱스 배열(0=출발지 제외, 1..n). 전체 소요시간(finish)을 계산.
// 추가로, 오픈시간이 있는 지점들 중 "경로상 가장 마지막에 방문하는 곳"에서 생기는 대기는
// bufferWaitS(= 마감시간을 지키기 위한 안전 버퍼)로 따로 집계하고, 그 전에 다른 오픈시간
// 지점에서 생기는 대기는 earlyWaitS(= 가급적 없애야 할 낭비성 대기)로 구분해서 집계한다.
// 이렇게 나누는 이유: 중간에 대기가 생기면 그 뒤 일정이 조금만 늦어져도 마지막 마감시간을
// 놓칠 위험이 커지지만, 마지막 지점 직전의 대기는 오히려 지연에 대비하는 안전 여유가 된다.
function simulateSchedule(order, durations, distances, openSecs, departSec, dwellSec, returnToStart) {
  let cur = departSec, totalDriveS = 0, totalDist = 0, totalWaitS = 0;
  let prev = 0;

  let lastTimedPos = -1;
  for (let i = 0; i < order.length; i++) {
    if (openSecs[order[i]] != null) lastTimedPos = i;
  }

  let earlyWaitS = 0, bufferWaitS = 0;
  for (let i = 0; i < order.length; i++) {
    const node = order[i];
    const drive = durations[prev][node];
    cur += drive; totalDriveS += drive; totalDist += distances[prev][node];
    const openSec = openSecs[node];
    if (openSec != null && cur < openSec) {
      const w = openSec - cur;
      totalWaitS += w;
      if (i === lastTimedPos) bufferWaitS += w; else earlyWaitS += w;
      cur = openSec;
    }
    cur += dwellSec;
    prev = node;
  }
  if (returnToStart) {
    cur += durations[prev][0]; totalDriveS += durations[prev][0]; totalDist += distances[prev][0];
  }
  return {
    finish: cur, totalDriveS: totalDriveS, totalDist: totalDist,
    totalWaitS: totalWaitS, earlyWaitS: earlyWaitS, bufferWaitS: bufferWaitS
  };
}

// 우선순위를 확실히 구분하기 위해 사전식(lexicographic) 비교를 하나의 숫자로 인코딩:
//   1순위) 실제 총 소요시간(finish) — 이게 조금이라도 늘어나는 선택은 절대 하지 않음
//   2순위) 총 주행거리(totalDist) — 시간이 똑같다면 왕복 지그재그처럼 괜히 더 도는 경로는 피함
//   3순위) earlyWaitS — 시간·거리가 둘 다 같을 때만, 대기를 마지막 마감시간 지점 앞으로 몰아줌
// 각 자릿수 차이가 절대 섞이지 않도록 자릿수를 충분히 벌려둠.
function scheduleCost(order, durations, distances, openSecs, departSec, dwellSec, returnToStart) {
  const sim = simulateSchedule(order, durations, distances, openSecs, departSec, dwellSec, returnToStart);
  return sim.finish * 1e10 + sim.totalDist * 100 + sim.earlyWaitS;
}

function nearestNeighborOrder(n, durations) {
  const nodeList = []; for (let i = 1; i <= n; i++) nodeList.push(i);
  return nearestNeighborOrderSubset(nodeList, durations);
}

// nodeList(특정 노드들만)로 한정해서 nearest-neighbor 순서를 짬. 출발지(0)부터 시작.
function nearestNeighborOrderSubset(nodeList, durations) {
  const remaining = nodeList.slice();
  const order = []; let prev = 0;
  while (remaining.length) {
    let bestIdx = 0, bestVal = Infinity;
    for (let r = 0; r < remaining.length; r++) {
      if (durations[prev][remaining[r]] < bestVal) { bestVal = durations[prev][remaining[r]]; bestIdx = r; }
    }
    const node = remaining.splice(bestIdx, 1)[0];
    order.push(node); prev = node;
  }
  return order;
}

// skeleton(이미 정해진 순서) 안의 가장 좋은 자리 하나에 node를 끼워 넣는다.
// (skeleton 자체의 순서는 절대 흐트러뜨리지 않고, node를 넣을 위치만 고름 → 지그재그 방지)
function bestInsertion(skeleton, node, durations, distances, openSecs, departSec, dwellSec, returnToStart) {
  let bestPos = 0, bestCost = Infinity;
  for (let k = 0; k <= skeleton.length; k++) {
    const cand = skeleton.slice(0, k).concat([node]).concat(skeleton.slice(k));
    const cost = scheduleCost(cand, durations, distances, openSecs, departSec, dwellSec, returnToStart);
    if (cost < bestCost - 1e-9) { bestCost = cost; bestPos = k; }
  }
  return skeleton.slice(0, bestPos).concat([node]).concat(skeleton.slice(bestPos));
}

// 2-opt(구간 뒤집기) + or-opt(한 곳 위치 옮기기) 지역 탐색으로,
// scheduleCost(=총 소요시간 + 낭비성 대기 페널티)가 최소가 되는 순서를 찾음.
// 배달처 10~20곳 규모면 충분히 빠름.
function localSearchMinFinish(initialOrder, durations, distances, openSecs, departSec, dwellSec, returnToStart) {
  let order = initialOrder.slice();
  let bestCost = scheduleCost(order, durations, distances, openSecs, departSec, dwellSec, returnToStart);
  let improved = true, iter = 0;
  while (improved && iter < 60) {
    improved = false; iter++;
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const cand = order.slice(0, i).concat(order.slice(i, j + 1).reverse()).concat(order.slice(j + 1));
        const cost = scheduleCost(cand, durations, distances, openSecs, departSec, dwellSec, returnToStart);
        if (cost < bestCost - 1e-6) { order = cand; bestCost = cost; improved = true; }
      }
    }
    for (let i = 0; i < order.length; i++) {
      const node = order[i];
      const without = order.slice(0, i).concat(order.slice(i + 1));
      for (let k = 0; k <= without.length; k++) {
        const cand = without.slice(0, k).concat([node]).concat(without.slice(k));
        const cost = scheduleCost(cand, durations, distances, openSecs, departSec, dwellSec, returnToStart);
        if (cost < bestCost - 1e-6) { order = cand; bestCost = cost; improved = true; }
      }
    }
  }
  return { order: order, cost: bestCost };
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

    // ---------- mode: timeWindow ----------
    // 오픈시간이 있는 배달처는 "그 시간 근처에 도착하도록" 순서를 배치하고,
    // 조금 일찍 도착하면 대기했다가 진행하는 것까지 감안해서, 출발~복귀까지
    // 전체 걸리는 시간이 최소가 되는 순서를 계산합니다.
    // body: { mode:'timeWindow', start, stops:[{lat,lng,_ref,openMin(0~1439, 없으면 null)}...],
    //         departMin(출발시각, 0~1439), dwellMin(상하차 소요분), returnToStart }
    if (body.mode === 'timeWindow') {
      const start = body.start;
      const stops = Array.isArray(body.stops) ? body.stops : [];
      const departMin = typeof body.departMin === 'number' ? body.departMin : 180;
      const dwellMin = typeof body.dwellMin === 'number' ? body.dwellMin : 5;

      if (!start || typeof start.lat !== 'number' || typeof start.lng !== 'number') {
        return res.status(400).json({ error: 'missing_start' });
      }
      if (!stops.length) {
        return res.status(400).json({ error: 'missing_stops' });
      }

      try {
        const points = [start].concat(stops);
        const table = await fetchTable(points);
        const n = stops.length;
        const openSecs = [null];
        stops.forEach(function (s) { openSecs.push(typeof s.openMin === 'number' ? s.openMin * 60 : null); });
        const departSec = departMin * 60;
        const dwellSec = dwellMin * 60;

        // ---- 새 방식: "오픈시간 무시한 자연스러운 최단동선"을 뼈대로 두고,
        //      오픈시간 있는 곳들만 그 동선 안에서 제일 시간이 맞는 자리에 끼워 넣는다.
        // (기존처럼 전체를 통째로 다시 최적화하면, 오픈시간이 여러 곳일 때 동선이
        //  지그재그로 심하게 틀어지는 부작용이 있었음 — 뼈대를 고정해두면 그 문제가 없음)
        const timedNodes = [], untimedNodes = [];
        for (let i = 1; i <= n; i++) {
          (openSecs[i] != null ? timedNodes : untimedNodes).push(i);
        }

        // 1) 오픈시간 없는 곳들만으로 순수 최단동선 뼈대를 만듦 (거리/시간만 기준, 대기 없음)
        let skeleton = nearestNeighborOrderSubset(untimedNodes, table.durations);
        if (untimedNodes.length > 1) {
          skeleton = localSearchMinFinish(skeleton, table.durations, table.distances, openSecs, departSec, dwellSec, returnToStart).order;
        }

        // 2) 뼈대(오픈시간 무시 동선)를 그대로 따라갔을 때 각 지점 도착시각을 미리 계산해두고,
        //    오픈시간 있는 곳은 "그 시각과 제일 비슷한 시점"의 자리에 끼워 넣는다.
        //    (거리/시간을 다시 비교해서 먼 곳으로 옮기지 않고, 순전히 "그 동네를 지나가는 시점"
        //     기준으로만 끼워 넣기 때문에 지그재그가 생기지 않음)
        let refCur = departSec, refPrev = 0;
        const arrival = skeleton.map(function (node) {
          refCur += table.durations[refPrev][node];
          const t = refCur;
          refCur += dwellSec;
          refPrev = node;
          return t;
        });

        timedNodes.sort(function (a, b) { return openSecs[a] - openSecs[b]; });
        const slots = timedNodes.map(function (node) {
          let pos = skeleton.length; // 기본값: 다 지나도 아직 시간이 안 됐으면 맨 뒤
          for (let i = 0; i < arrival.length; i++) {
            if (arrival[i] > openSecs[node]) { pos = i; break; }
          }
          return { node: node, pos: pos, openSec: openSecs[node] };
        });
        // 같은 자리에 여러 곳이 몰리면 마감시간이 이른 순서대로 나열
        slots.sort(function (a, b) { return (a.pos - b.pos) || (a.openSec - b.openSec); });

        const order = [];
        let si = 0;
        for (let i = 0; i <= skeleton.length; i++) {
          while (si < slots.length && slots[si].pos === i) { order.push(slots[si].node); si++; }
          if (i < skeleton.length) order.push(skeleton[i]);
        }
        const sim = simulateSchedule(order, table.durations, table.distances, openSecs, departSec, dwellSec, returnToStart);

        const legs = [];
        let prev = 0;
        order.forEach(function (node) {
          legs.push({ distanceM: table.distances[prev][node], durationS: table.durations[prev][node] });
          prev = node;
        });
        const orderedStops = order.map(function (node) { return stops[node - 1]; });

        return res.status(200).json({
          order: orderedStops, legs: legs,
          totalDistanceM: sim.totalDist, totalDurationS: sim.totalDriveS, totalWaitS: sim.totalWaitS
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
      const wantGeometry = !!body.geometry;
      const routePoints = returnToStart ? points.concat([start]) : points;
      const overviewParams = wantGeometry ? '&overview=full&geometries=geojson' : '&overview=false';
      const d = await osrmGet('https://router.project-osrm.org/route/v1/driving/' + coordStr(routePoints) +
        '?steps=false' + overviewParams);
      if (d.code !== 'Ok') {
        return res.status(502).json({ error: 'osrm_error', detail: d.code, message: d.message || '' });
      }
      const route = d.routes[0];
      const legs = (route.legs || []).map(function (leg) { return { distanceM: leg.distance, durationS: leg.duration }; });
      const resp = { order: stops, legs: legs, totalDistanceM: route.distance, totalDurationS: route.duration };
      if (wantGeometry && route.geometry && route.geometry.coordinates) resp.geometry = route.geometry.coordinates;
      return res.status(200).json(resp);
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
