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
// endIdx: 마지막 지점에서 도착해야 할 "복귀/도착지" 노드 인덱스.
//   null  = 마지막 배달지에서 그냥 끝(별도 복귀/도착지 없음)
//   0     = 출발지로 복귀
//   그 외 = 별도로 지정한 도착지 노드(예: n+1, points 배열의 마지막)
function simulateSchedule(order, durations, distances, openSecs, departSec, dwellSec, endIdx) {
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
  if (endIdx != null) {
    cur += durations[prev][endIdx]; totalDriveS += durations[prev][endIdx]; totalDist += distances[prev][endIdx];
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
function scheduleCost(order, durations, distances, openSecs, departSec, dwellSec, endIdx) {
  const sim = simulateSchedule(order, durations, distances, openSecs, departSec, dwellSec, endIdx);
  return sim.finish * 1e10 + sim.totalDist * 100 + sim.earlyWaitS;
}

// order 순서대로 갔을 때, 대기를 적용하기 "전" 각 지점의 순수 도착시각(운전만 반영)을 배열로 반환.
// 오픈시간 있는 곳이 실제로 오픈시간 전에 도착하는지 확인할 때 씀.
function rawArrivalTimes(order, durations, dwellSec, departSec, openSecs) {
  let cur = departSec, prev = 0;
  return order.map(function (node) {
    cur += durations[prev][node];
    const rawArrival = cur;
    const openSec = openSecs[node];
    if (openSec != null && cur < openSec) cur = openSec; // 이전 지점이 오픈시간 있는 곳이면 대기 반영
    cur += dwellSec;
    prev = node;
    return rawArrival;
  });
}

function totalDistOf(order, distances, endIdx) {
  let d = 0, prev = 0;
  order.forEach(function (node) { d += distances[prev][node]; prev = node; });
  if (endIdx != null) d += distances[prev][endIdx];
  return d;
}

// 오픈시간이 있는 node를 skeleton 안에 끼워 넣되, "오픈시간보다 최소 bufferSec만큼 일찍 도착"하는
// 조건을 최우선으로 만족하는 자리를 고른다 (늦게 도착하는 자리는 정말 다른 방법이 전혀 없을 때만 선택).
// 그 조건을 만족하는 자리가 여럿이면, 그중 버퍼가 딱 bufferSec에 가장 가까운(너무 일찍도 아닌) 자리,
// 그것도 같으면 주행거리가 제일 적게 늘어나는 자리를 고른다.
function bestInsertionBeforeOpen(skeleton, node, durations, distances, openSecs, departSec, dwellSec, returnToStart, bufferSec) {
  const openSec = openSecs[node];
  const target = openSec - bufferSec;
  let bestPos = 0, bestCost = Infinity;
  for (let k = 0; k <= skeleton.length; k++) {
    const cand = skeleton.slice(0, k).concat([node]).concat(skeleton.slice(k));
    const raw = rawArrivalTimes(cand, durations, dwellSec, departSec, openSecs);
    const rawAtNode = raw[k];
    const lateness = Math.max(0, rawAtNode - target); // 0이면 버퍼 조건 충족(=늦지 않음)
    const slack = Math.max(0, target - rawAtNode);     // 버퍼보다 얼마나 더 일찍인지(작을수록 효율적)
    const dist = totalDistOf(cand, distances, returnToStart);
    const cost = lateness * 1e12 + slack * 1e6 + dist;
    if (cost < bestCost - 1e-9) { bestCost = cost; bestPos = k; }
  }
  return skeleton.slice(0, bestPos).concat([node]).concat(skeleton.slice(bestPos));
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
  // end: 출발지와 별도로 지정한 "도착지"(자택/창고/가락시장 등). 있으면 항상 이 지점이 마지막
  // 방문지가 되며(오픈시간과 무관하게 무조건 마지막), returnToStart 값보다 우선합니다.
  const endPt = body.end && typeof body.end.lat === 'number' && typeof body.end.lng === 'number' ? body.end : null;

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
        const endTarget = endPt || (returnToStart ? start : null);
        if (endTarget) {
          const seg = await optimizeBounded(lastAnchor, lastFloats, endTarget);
          segmentsOrder.push(seg.order);
          // 마지막 leg는 출발지 복귀/도착지 leg라 특정 배달처 도착은 아니지만, 화면에서 마지막
          // 도착지를 표시할 수 있도록 legs 배열 끝에는 그대로 포함시켜 둠(스케줄 매칭에서는
          // seqOut.length개(=배달처 수)만큼만 쓰고 그 다음 하나가 이 leg가 됨).
          scheduleLegs.push.apply(scheduleLegs, seg.legs);
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
        const points = [start].concat(stops).concat(endPt ? [endPt] : []);
        const table = await fetchTable(points);
        const n = stops.length;
        const openSecs = [null];
        stops.forEach(function (s) { openSecs.push(typeof s.openMin === 'number' ? s.openMin * 60 : null); });
        if (endPt) openSecs.push(null);
        const departSec = departMin * 60;
        const dwellSec = dwellMin * 60;
        // endIdx: 0=출발지로 복귀, n+1=별도 지정한 도착지, null=복귀 없음
        const endIdx = endPt ? (n + 1) : (returnToStart ? 0 : null);

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
          skeleton = localSearchMinFinish(skeleton, table.durations, table.distances, openSecs, departSec, dwellSec, endIdx).order;
        }

        // 2) 오픈시간 있는 곳들을 마감시간이 이른 순서대로, 뼈대 안에서
        //    "오픈시간보다 최소 10분 이상 일찍 도착"하는 자리에 끼워 넣는다.
        //    (그런 자리가 여러 곳이면 그중 버퍼가 10분에 제일 가까운(=낭비 없는) 자리를 고르고,
        //     정말 방법이 없을 때만 어쩔 수 없이 제일 덜 늦는 자리를 고름)
        const OPEN_BUFFER_SEC = 10 * 60;
        timedNodes.sort(function (a, b) { return openSecs[a] - openSecs[b]; });
        timedNodes.forEach(function (node) {
          skeleton = bestInsertionBeforeOpen(skeleton, node, table.durations, table.distances, openSecs, departSec, dwellSec, endIdx, OPEN_BUFFER_SEC);
        });

        const order = skeleton;
        const sim = simulateSchedule(order, table.durations, table.distances, openSecs, departSec, dwellSec, endIdx);

        // 혹시라도 정말 못 피한 지각이 있으면 경고용으로 표시할 수 있게 계산해둠
        const rawArr = rawArrivalTimes(order, table.durations, dwellSec, departSec, openSecs);
        const lateStops = [];
        order.forEach(function (node, idx) {
          const openSec = openSecs[node];
          if (openSec != null && rawArr[idx] > openSec) {
            lateStops.push({ _ref: stops[node - 1] && stops[node - 1]._ref, lateBySec: rawArr[idx] - openSec });
          }
        });

        const legs = [];
        let prev = 0;
        order.forEach(function (node) {
          legs.push({ distanceM: table.distances[prev][node], durationS: table.durations[prev][node] });
          prev = node;
        });
        // endIdx가 있으면(출발지 복귀 또는 별도 도착지) 마지막 배달지→그 지점까지의 leg도
        // 배열 맨 끝에 추가로 넣어줌(화면에서 "마지막 도착지"를 따로 표시할 수 있게).
        if (endIdx != null) {
          legs.push({ distanceM: table.distances[prev][endIdx], durationS: table.durations[prev][endIdx] });
        }
        const orderedStops = order.map(function (node) { return stops[node - 1]; });

        return res.status(200).json({
          order: orderedStops, legs: legs,
          totalDistanceM: sim.totalDist, totalDurationS: sim.totalDriveS, totalWaitS: sim.totalWaitS,
          lateStops: lateStops
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
      const routePoints = endPt ? points.concat([endPt]) : (returnToStart ? points.concat([start]) : points);
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
    // endPt가 있으면 출발지·도착지를 양끝에 고정하고(source=first&destination=last) 그 사이만
    // 최적화합니다(roundtrip은 그 경우 의미가 없어 false로 둠).
    const tripPoints = endPt ? points.concat([endPt]) : points;
    const url = 'https://router.project-osrm.org/trip/v1/driving/' + coordStr(tripPoints) +
      '?source=first' + (endPt ? '&destination=last&roundtrip=false' : ('&roundtrip=' + (returnToStart ? 'true' : 'false'))) +
      '&steps=false&overview=false';
    const d = await osrmGet(url);

    if (d.code !== 'Ok') {
      return res.status(502).json({ error: 'osrm_error', detail: d.code, message: d.message || '' });
    }

    // waypoints[]는 입력 순서(start=0, stops=1..n, [있다면 도착지=n+1])와 매핑되고,
    // 각 항목의 waypoint_index가 최적 방문 순서(0=출발지)를 알려줍니다.
    const endInputIdx = endPt ? tripPoints.length - 1 : -1;
    const ordered = d.waypoints
      .map(function (w, i) { return { inputIndex: i, tripIndex: w.waypoint_index }; })
      .filter(function (w) { return w.inputIndex !== 0 && w.inputIndex !== endInputIdx; })
      .sort(function (a, b) { return a.tripIndex - b.tripIndex; })
      .map(function (w) { return stops[w.inputIndex - 1]; });

    const trip = d.trips[0];
    const legs = (trip.legs || []).map(function (leg) { return { distanceM: leg.distance, durationS: leg.duration }; });

    return res.status(200).json({ order: ordered, legs: legs, totalDistanceM: trip.distance, totalDurationS: trip.duration });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String(e) });
  }
};
