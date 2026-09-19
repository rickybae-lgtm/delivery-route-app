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

// 오픈시간이 있는 node를 skeleton 안에 끼워 넣는다.
// 최우선 기준은 항상 "전체 동선 효율"(scheduleCost: 총 소요시간 > 총 거리 > 낭비성 대기)이고,
// "오픈시간보다 bufferSec(기본 10분)만큼 일찍 도착"하는 건 어디까지나 "되도록이면" 지켜지면
// 좋은 선호일 뿐, 그것 때문에 동선을 억지로 돌아가게 만들지는 않는다. 그래서 버퍼를 못 채우는
// 정도(missBuffer)는 아주 작은 가중치만 줘서, 전체 효율이 동점에 가까울 때만 정해준다.
function bestInsertionBeforeOpen(skeleton, node, durations, distances, openSecs, departSec, dwellSec, returnToStart, bufferSec) {
  const openSec = openSecs[node];
  const target = openSec - bufferSec;
  let bestPos = 0, bestCost = Infinity;
  for (let k = 0; k <= skeleton.length; k++) {
    const cand = skeleton.slice(0, k).concat([node]).concat(skeleton.slice(k));
    const raw = rawArrivalTimes(cand, durations, dwellSec, departSec, openSecs);
    const rawAtNode = raw[k];
    const missBuffer = Math.max(0, rawAtNode - target); // 10분 버퍼를 못 채운 정도(초) — 참고용 선호일 뿐
    const cost = scheduleCost(cand, durations, distances, openSecs, departSec, dwellSec, returnToStart) + missBuffer;
    if (cost < bestCost - 1e-9) { bestCost = cost; bestPos = k; }
  }
  return skeleton.slice(0, bestPos).concat([node]).concat(skeleton.slice(bestPos));
}

// bestInsertionBeforeOpen의 "묶음(segment)" 버전. 같은 주소라 함께 붙어 다녀야 하는
// 오픈시간 지점들을 하나의 덩어리로 취급해서, skeleton의 모든 자리에 넣어보고
// 실제 총 소요시간(scheduleCost, 대기 포함)이 제일 짧은 자리를 그대로 고른다.
// 순수 거리만 보는 뼈대와 달리, 여기서는 "이 자리에 넣으면 대기가 얼마나 생기는지"까지
// 정확히 계산해서 비교하기 때문에, 대기를 감수하는 것과 다른 곳을 먼저 들르고 오는 것 중
// 실제로 더 빠른 쪽이 자동으로 선택된다.
function bestInsertionSegmentBeforeOpen(skeleton, segment, durations, distances, openSecs, departSec, dwellSec, returnToStart, bufferSec) {
  let bestPos = 0, bestCost = Infinity;
  for (let k = 0; k <= skeleton.length; k++) {
    const cand = skeleton.slice(0, k).concat(segment).concat(skeleton.slice(k));
    const raw = rawArrivalTimes(cand, durations, dwellSec, departSec, openSecs);
    let missBuffer = 0;
    segment.forEach(function (node, idx) {
      const openSec = openSecs[node];
      if (openSec == null) return;
      const target = openSec - bufferSec;
      missBuffer += Math.max(0, raw[k + idx] - target);
    });
    const cost = scheduleCost(cand, durations, distances, openSecs, departSec, dwellSec, returnToStart) + missBuffer;
    if (cost < bestCost - 1e-9) { bestCost = cost; bestPos = k; }
  }
  return skeleton.slice(0, bestPos).concat(segment).concat(skeleton.slice(bestPos));
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
  while (improved && iter < 40) {
    improved = false; iter++;
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const cand = order.slice(0, i).concat(order.slice(i, j + 1).reverse()).concat(order.slice(j + 1));
        const cost = scheduleCost(cand, durations, distances, openSecs, departSec, dwellSec, returnToStart);
        if (cost < bestCost - 1e-6) { order = cand; bestCost = cost; improved = true; }
      }
    }
    // or-opt: 한 곳(길이 1)뿐 아니라 두세 곳을 묶어서(길이 2, 3) 통째로 다른 자리에 옮겨보는 것도
    // 시도함. 한 곳만 옮겨서는 개선이 안 보여도, 붙어있는 여러 곳을 통째로 옮기면(예: 같은 동네
    // 몇 곳을 한 번에 뒤로 미뤄서 오픈시간 대기를 줄이는 경우) 개선되는 경우가 있어서.
    for (let segLen = 1; segLen <= 3; segLen++) {
      for (let i = 0; i + segLen <= order.length; i++) {
        const segment = order.slice(i, i + segLen);
        const without = order.slice(0, i).concat(order.slice(i + segLen));
        for (let k = 0; k <= without.length; k++) {
          const cand = without.slice(0, k).concat(segment).concat(without.slice(k));
          const cost = scheduleCost(cand, durations, distances, openSecs, departSec, dwellSec, returnToStart);
          if (cost < bestCost - 1e-6) { order = cand; bestCost = cost; improved = true; }
        }
      }
    }
  }
  return { order: order, cost: bestCost };
}

// 순서 일부를 무작위로 크게 흔들어주는 "더블 브릿지" 섞기. 2-opt/or-opt만 계속 돌리면
// 어중간한 모양(예: 가까운 두 곳 사이에 먼 곳이 끼어있는데, 그 하나를 빼거나 구간을
// 뒤집는 것만으로는 더 나아지지 않아서 그대로 멈춰버리는 경우)에 갇힐 수 있어서,
// 가끔 크게 흔들었다가 다시 다듬어 보고 그게 더 나으면 채택하는 방식으로 그런 함정을 피한다.
function doubleBridgeShuffle(order) {
  const n = order.length;
  if (n < 8) return order.slice();
  const pts = [];
  while (pts.length < 3) {
    const p = 1 + Math.floor(Math.random() * (n - 1));
    if (pts.indexOf(p) === -1) pts.push(p);
  }
  pts.sort(function (a, b) { return a - b; });
  const A = order.slice(0, pts[0]), B = order.slice(pts[0], pts[1]), C = order.slice(pts[1], pts[2]), D = order.slice(pts[2]);
  return A.concat(C).concat(B).concat(D);
}

// localSearchMinFinish로 한 번 다듬은 다음, 몇 번 더 크게 흔들었다가 다시 다듬어보고
// (iterated local search) 그중 제일 좋은 결과를 채택한다. 배달처 10~20곳 규모면 순식간에 끝남.
function localSearchWithRestarts(initialOrder, durations, distances, openSecs, departSec, dwellSec, endIdx, restarts) {
  let best = localSearchMinFinish(initialOrder, durations, distances, openSecs, departSec, dwellSec, endIdx);
  for (let r = 0; r < restarts; r++) {
    const shuffled = doubleBridgeShuffle(best.order);
    const res = localSearchMinFinish(shuffled, durations, distances, openSecs, departSec, dwellSec, endIdx);
    if (res.cost < best.cost - 1e-6) best = res;
  }
  return best;
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

        // ---- 새 방식: 오픈시간 없는 곳들만으로 순수 최단동선 뼈대를 만들고,
        //      오픈시간 있는 곳(같은 주소면 한 덩어리로 묶어서)을 그 뼈대의
        //      "모든 자리"에 실제로 넣어보고 총 소요시간이 제일 짧은 자리를 그대로 선택한다.
        //      이러면 "대기를 감수하는 것"과 "다른 곳 먼저 들르고 오는 것" 중 실제로
        //      더 빠른 쪽이 계산으로 결정되고, 뼈대 자체를 억지로 고정하지 않는다.
        function coordKey(pt) { return pt.lat.toFixed(5) + ',' + pt.lng.toFixed(5); }
        const groupMap = {};
        for (let i = 1; i <= n; i++) {
          const key = coordKey(stops[i - 1]);
          (groupMap[key] = groupMap[key] || []).push(i);
        }
        const allBlocks = Object.keys(groupMap).map(function (k) { return groupMap[k]; });
        const untimedBlocks = [], timedBlocks = [];
        allBlocks.forEach(function (block) {
          const hasTimed = block.some(function (node) { return openSecs[node] != null; });
          (hasTimed ? timedBlocks : untimedBlocks).push(block);
        });

        // 1) 오픈시간을 완전히 무시하고, "최단거리" 모드와 완전히 똑같은 방식(OSRM의
        //    trip 엔진 자체)으로 전체 지점(오픈시간 있는 곳 포함) 순수 최단동선을 만든다.
        //    예전에는 이걸 직접 짠 nearest-neighbor로 대충 흉내냈는데, 그러다 보니
        //    "최단거리" 탭이 보여주는 진짜 최적 동선과 미묘하게 달라져서 뼈대 자체가
        //    어긋나는 문제가 있었다. 이제 완전히 같은 엔진을 쓰므로 절대 어긋나지 않는다.
        const tripPoints0 = endPt ? points.concat([endPt]) : points;
        const tripUrl0 = 'https://router.project-osrm.org/trip/v1/driving/' + coordStr(tripPoints0) +
          '?source=first' + (endPt ? '&destination=last&roundtrip=false' : ('&roundtrip=' + (returnToStart ? 'true' : 'false'))) +
          '&steps=false&overview=false';
        const tripRes0 = await osrmGet(tripUrl0);
        if (tripRes0.code !== 'Ok') {
          return res.status(502).json({ error: 'osrm_error', detail: tripRes0.code, message: tripRes0.message || '' });
        }
        const endInputIdx0 = endPt ? tripPoints0.length - 1 : -1;
        let fullTour = tripRes0.waypoints
          .map(function (w, i) { return { inputIndex: i, tripIndex: w.waypoint_index }; })
          .filter(function (w) { return w.inputIndex !== 0 && w.inputIndex !== endInputIdx0; })
          .sort(function (a, b) { return a.tripIndex - b.tripIndex; })
          .map(function (w) { return w.inputIndex; }); // points 배열 기준 인덱스 = stops 기준으로는 그대로 1..n (start가 0번이라 동일)

        // 오픈시간 있는 블록만 이 뼈대에서 도로 빼낸다. 오픈시간 없는 지점들의
        // 상대적인 순서(예: 9번이 앞쪽에 있던 것)는 그대로 유지된다.
        const timedNodeSet = {};
        timedBlocks.forEach(function (block) { block.forEach(function (node) { timedNodeSet[node] = true; }); });
        let skeleton = fullTour.filter(function (node) { return !timedNodeSet[node]; });

        // 2) 오픈시간 있는 블록들을, 오픈시간이 이른 순서대로, 뼈대의 모든 자리에
        //    실제로 넣어보고 총 소요시간이 제일 짧은 자리를 선택해서 끼워 넣는다.
        const OPEN_BUFFER_SEC = 10 * 60;
        timedBlocks.sort(function (a, b) {
          const openA = Math.min.apply(null, a.filter(function (x) { return openSecs[x] != null; }).map(function (x) { return openSecs[x]; }));
          const openB = Math.min.apply(null, b.filter(function (x) { return openSecs[x] != null; }).map(function (x) { return openSecs[x]; }));
          return openA - openB;
        });
        timedBlocks.forEach(function (block) {
          skeleton = bestInsertionSegmentBeforeOpen(skeleton, block, table.durations, table.distances, openSecs, departSec, dwellSec, endIdx, OPEN_BUFFER_SEC);
        });

        // 2.5) (의도적으로 생략) 전에는 여기서 전체 순서를 2-opt로 한 번 더 다듬었는데,
        //      이게 오픈시간 있는 지점의 대기를 줄이려고 애초에 잡아둔 "최단거리 뼈대"
        //      자체를 통째로 뒤집어버리는 부작용이 있었다(예: 잠실을 먼저 들르는 뼈대를
        //      버리고 신사동부터 도는 걸로 바꿔버림). 뼈대는 1)번에서 이미 최단으로
        //      정해졌고, 오픈시간 지점은 2)번에서 이미 제일 좋은 자리로 넣었으므로,
        //      여기서 더 손대지 않고 그대로 둔다.

        // 3) 같은 주소(=사실상 같은 좌표)에 등록된 배달처들은 절대 흩어지지 않게 함
        //    (2.5의 미세 조정 과정에서 혹시라도 벌어졌을 경우를 대비한 안전장치).
        let order = skeleton;
        const sameAddrGroups = {};
        for (let i = 1; i <= n; i++) {
          const key = coordKey(stops[i - 1]);
          (sameAddrGroups[key] = sameAddrGroups[key] || []).push(i);
        }
        Object.keys(sameAddrGroups).forEach(function (key) {
          const group = sameAddrGroups[key];
          if (group.length < 2) return;
          const positions = group.map(function (node) { return order.indexOf(node); }).sort(function (a, b) { return a - b; });
          const alreadyTogether = positions[positions.length - 1] - positions[0] === positions.length - 1;
          if (alreadyTogether) return;
          const anchorPos = positions[0];
          let insertAt = 0;
          for (let idx = 0; idx < anchorPos; idx++) {
            if (group.indexOf(order[idx]) === -1) insertAt++;
          }
          const withoutGroup = order.filter(function (node) { return group.indexOf(node) === -1; });
          order = withoutGroup.slice(0, insertAt).concat(group).concat(withoutGroup.slice(insertAt));
        });

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
