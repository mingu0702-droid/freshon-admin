export const MAX_VISITS = 30;
const SECONDS_PER_DAY = 86400;

function located(point) {
  return Number.isFinite(point?.lat) && point.lat >= 33 && point.lat <= 39.5 &&
    Number.isFinite(point.lng) && point.lng >= 124 && point.lng <= 132;
}

export function orderedVisits(visits) {
  const orders = visits.map(visit => Number(visit.order));
  const confirmed = orders.every(order => Number.isSafeInteger(order) && order > 0) &&
    new Set(orders).size === visits.length;
  return {
    confirmed,
    visits: confirmed ? [...visits].sort((a, b) => a.order - b.order) : [...visits],
  };
}

export function arrivalRouteDraft(center, visits) {
  if (!visits.length || visits.length > MAX_VISITS) throw Error('방문지는 30곳까지 조회할 수 있습니다.');
  if (!located(center)) throw Error('오산센터 출발 위치를 확인할 수 없습니다.');
  if (!visits.every(located)) throw Error('위치가 미확인된 배송지가 있습니다.');
  const points = visits.map(({ lat, lng }, index) => ({ id: 'arrival-stop-' + (index + 1), lat, lng }));
  return {
    mode: 'MANUAL_WAYPOINTS',
    origin: { id: 'arrival-osan', lat: center.lat, lng: center.lng },
    waypoints: points.slice(0, -1).map((point, index) => ({ ...point, order: index + 1 })),
    destination: points.at(-1),
  };
}

function departureSeconds(time) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const [hour, minute] = time.split(':').map(Number);
  return (hour * 60 + minute) * 60;
}

function workMinutesValid(minutes) {
  return Number.isSafeInteger(minutes * 60) && Number.isInteger(minutes) && minutes >= 0;
}

export function arrivalSchedule(route, departure, workMinutes) {
  const start = departureSeconds(departure);
  if (start === null || !workMinutes.length || workMinutes.length > MAX_VISITS ||
    !workMinutes.every(workMinutesValid)) return null;
  if (route?.state !== 'success' || route.complete !== true || !Array.isArray(route.legs) ||
    route.legs.length !== workMinutes.length) return null;

  const byIndex = new Map(route.legs.map(leg => [leg?.index, leg]));
  let driveSeconds = 0;
  let workSeconds = 0;
  const stops = [];
  for (const [index, minutes] of workMinutes.entries()) {
    const leg = byIndex.get(index);
    if (![leg?.distanceMeters, leg?.durationSeconds].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
    driveSeconds += leg.durationSeconds;
    const arrival = start + driveSeconds + workSeconds;
    workSeconds += minutes * 60;
    stops.push({
      distanceMeters: leg.distanceMeters, driveSeconds: leg.durationSeconds,
      arrival, departure: start + driveSeconds + workSeconds,
    });
  }
  if (!Number.isSafeInteger(start + driveSeconds + workSeconds)) return null;
  return { stops, driveSeconds, workSeconds, elapsedSeconds: driveSeconds + workSeconds, finish: stops.at(-1).departure };
}

export function arrivalClock(seconds) {
  const day = Math.floor(seconds / SECONDS_PER_DAY);
  const hour = Math.floor(seconds % SECONDS_PER_DAY / 3600);
  const minute = Math.floor(seconds % 3600 / 60);
  const prefix = day === 1 ? '익일 ' : day > 1 ? '+' + day + '일 ' : '';
  return prefix + [hour, minute].map(part => String(part).padStart(2, '0')).join(':');
}

function durationLabel(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return [hours ? hours + '시간' : '', minutes || !remainder ? minutes + '분' : '',
    remainder ? remainder + '초' : ''].filter(Boolean).join(' ');
}

const distanceLabel = meters => meters < 1000 ? meters + 'm' : (meters / 1000).toFixed(2) + 'km';

function mount(root, panel) {
  const select = name => panel.querySelector('[data-arrival-' + name + ']');
  const departure = select('departure');
  const confirm = select('confirm');
  const confirmLabel = select('confirm-label');
  const status = select('status');
  const button = select('query');
  const busy = select('busy');
  const list = select('list');
  const totals = select('totals');
  const bridge = root.MapUiLocalBridge;
  const metricNames = ['총 운전시간', '배송 작업시간', '총 예상 소요시간', '배송 종료'];
  let signature = null;
  let visits = [];
  let hasSavedOrder = false;
  let block = '';
  let route = null;
  let loading = false;
  let multiWaypoint = false;

  function showSchedule() {
    const result = arrivalSchedule(route, departure.value, visits.map(visit => visit.work));
    totals.hidden = !result;
    if (result) {
      const values = [durationLabel(result.driveSeconds), durationLabel(result.workSeconds),
        durationLabel(result.elapsedSeconds), arrivalClock(result.finish)];
      totals.replaceChildren(...values.map((value, index) => {
        const item = document.createElement('div');
        const title = document.createElement('dt');
        const detail = document.createElement('dd');
        title.textContent = metricNames[index];
        detail.textContent = value;
        item.append(title, detail);
        return item;
      }));
    } else totals.replaceChildren();

    visits.forEach((visit, index) => {
      const output = list.children[index]?.querySelector('output');
      if (!output) return;
      const stop = result?.stops[index];
      output.hidden = !stop;
      output.textContent = stop
        ? [distanceLabel(stop.distanceMeters), durationLabel(stop.driveSeconds), arrivalClock(stop.arrival) + ' 도착', arrivalClock(stop.departure) + ' 출발'].join(' · ')
        : '';
    });
  }

  function updateControls() {
    button.disabled = Boolean(block) || loading || (!hasSavedOrder && !confirm.checked) ||
      departureSeconds(departure.value) === null ||
      !visits.every(visit => workMinutesValid(visit.work)) ||
      !Number.isSafeInteger(visits.reduce((seconds, visit) => seconds + visit.work * 60, 0));
    busy.hidden = !loading;
  }

  const controller = root.ManualRoadRouteUi.createController({
    onChange(result) {
      loading = result.state === 'loading';
      route = result.state === 'success' && Array.isArray(result.legs) && result.legs.length === visits.length ? result : null;
      if (result.state === 'idle') status.textContent = block;
      else if (loading) status.textContent = '도로경로를 조회하고 있습니다.';
      else if (route) status.textContent = route.noDrivingRequired ? '같은 위치의 배송 작업시간을 반영했습니다.' : '현재 교통 기준 주행시간을 사용했습니다.';
      else if (multiWaypoint && ['CALL_POLICY_BLOCKED', 'QUOTA_EXCEEDED'].includes(result.error)) status.textContent = '다중 경유지 무료 사용 승인 또는 잔량을 확인해 주세요.';
      else if (result.state === 'partial' || result.state === 'success') status.textContent = '모든 구간의 이동시간을 확인하지 못했습니다.';
      else status.textContent = root.ManualRoadRouteUi.describe(result);
      updateControls();
      showSchedule();
    },
  });

  function renderVisits() {
    list.replaceChildren(...visits.map((visit, index) => {
      const item = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = (index + 1) + '. ' + visit.name;
      if (!located(visit)) name.textContent += ' · 위치 미확인';
      const controls = document.createElement('div');
      controls.className = 'arrival-stop-controls';
      const label = document.createElement('label');
      label.textContent = '작업(분) ';
      const work = document.createElement('input');
      work.type = 'number';
      work.min = '0';
      work.step = '1';
      work.value = Number.isNaN(visit.work) ? '' : String(visit.work);
      work.setAttribute('aria-label', (index + 1) + '번 배송지 ' + visit.name + ' 작업시간(분)');
      work.oninput = () => {
        visit.work = work.valueAsNumber;
        updateControls();
        showSchedule();
      };
      label.append(work);
      controls.append(label);
      for (const [offset, text] of [[-1, '위로'], [1, '아래로']]) {
        const move = document.createElement('button');
        move.type = 'button';
        move.textContent = offset < 0 ? '↑' : '↓';
        move.setAttribute('aria-label', (index + 1) + '번 배송지 ' + visit.name + ' ' + text + ' 이동');
        const other = index + offset;
        move.disabled = other < 0 || other >= visits.length;
        move.onclick = () => {
          [visits[index], visits[other]] = [visits[other], visits[index]];
          hasSavedOrder = false;
          confirm.checked = false;
          confirmLabel.hidden = false;
          controller.cancel();
          renderVisits();
          list.children[other]?.querySelector('input')?.focus();
        };
        controls.append(move);
      }
      const output = document.createElement('output');
      output.hidden = true;
      item.append(name, controls, output);
      return item;
    }));
  }

  function reset() {
    signature = null;
    panel.hidden = true;
    panel.open = false;
    delete panel.dataset.date;
    delete panel.dataset.vehicle;
    departure.value = '';
    confirm.checked = false;
    confirmLabel.hidden = true;
    hasSavedOrder = false;
    visits = [];
    block = '';
    list.replaceChildren();
    controller.cancel();
  }

  function sync() {
    const context = bridge.dailyArrivalContext();
    if (!context) {
      if (signature !== null) reset();
      return;
    }
    const center = root.MapNavigationLookup.registeredCenters().find(row => row.id === 'osan');
    const key = JSON.stringify([context, center?.lat, center?.lng]);
    if (signature === key) return;
    const sameRun = signature !== null && panel.dataset.date === context.date && panel.dataset.vehicle === context.vehicle;
    const wasOpen = panel.open;
    const time = departure.value;
    reset();
    signature = key;
    panel.dataset.date = context.date;
    panel.dataset.vehicle = context.vehicle;
    panel.hidden = false;
    if (sameRun) {
      panel.open = wasOpen;
      departure.value = time;
    }
    const ordered = orderedVisits(context.visits);
    visits = ordered.visits.map(visit => ({ ...visit, work: 15 }));
    hasSavedOrder = ordered.confirmed;
    block = context.count > MAX_VISITS ? '배송지 ' + context.count + '곳 · 최대 30곳까지 조회할 수 있습니다.' :
      !context.complete ? '전체 배송지를 확인할 수 없어 예상 도착시간을 계산할 수 없습니다.' :
      new Set(visits.map(visit => visit.id)).size !== visits.length ? '배송지를 개별 확인할 수 없습니다.' :
      !visits.every(located) ? '위치가 미확인된 배송지가 있습니다.' :
      !located(center) ? '오산센터 출발 위치를 확인할 수 없습니다.' : '';
    confirmLabel.hidden = hasSavedOrder || Boolean(block);
    status.textContent = block || (hasSavedOrder ? '저장된 방문 순서' : '방문 순서를 확인해 주세요.');
    renderVisits();
    updateControls();
  }

  departure.oninput = () => { updateControls(); showSchedule(); };
  confirm.onchange = updateControls;
  button.onclick = async () => {
    sync();
    if (button.disabled) return;
    const center = root.MapNavigationLookup.registeredCenters().find(row => row.id === 'osan');
    try {
      const draft = arrivalRouteDraft(center, visits);
      multiWaypoint = root.KakaoDirectionsAdapter.plan(draft).path === '/v1/waypoints/directions';
      await controller.load(draft, true);
    } catch (error) {
      status.textContent = error.message || '예상 도착시간을 조회하지 못했습니다.';
    }
  };
  root.addEventListener('map-daily-arrival-updated', sync);
  root.addEventListener('map-navigation-context-changed', reset);
  root.addEventListener('map-navigation-logout', reset);
  root.addEventListener('map-coordinate-updated', sync);
  root.addEventListener('map-sdk-ready', sync);
  sync();
}

if (typeof window === 'object' && window.MapUiLocalBridge?.dailyArrivalContext &&
  window.MapNavigationLookup && window.ManualRoadRouteUi) {
  const panel = document.getElementById('dailyRouteArrival');
  if (panel) mount(window, panel);
}
