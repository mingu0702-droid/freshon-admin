let currentPayload = { columns: [], rows: [] };
let statusTimer = null;

const TOKEN_KEY = "freshonAdminToken";

const statusEl = document.getElementById("status");
const tokenEl = document.getElementById("adminToken");
const saveTokenButton = document.getElementById("saveTokenButton");
const refreshButton = document.getElementById("refreshButton");
const reloadButton = document.getElementById("reloadButton");
const csvButton = document.getElementById("csvButton");
const routeRefreshButton = document.getElementById("routeRefreshButton");
const routeStartDate = document.getElementById("routeStartDate");
const routeEndDate = document.getElementById("routeEndDate");
const routeCenter = document.getElementById("routeCenter");
const routeVehicles = document.getElementById("routeVehicles");
const routeRefreshStatus = document.getElementById("routeRefreshStatus");
const table = document.getElementById("dataTable");

function setStatus(text) {
  statusEl.textContent = text;
}

function getToken() {
  return tokenEl.value.trim();
}

function saveToken() {
  const token = getToken();
  if (!token) {
    localStorage.removeItem(TOKEN_KEY);
    setStatus("저장된 관리 토큰을 지웠습니다.");
    return;
  }
  localStorage.setItem(TOKEN_KEY, token);
  setStatus("관리 토큰을 이 브라우저에 저장했습니다.");
}

function loadSavedToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) tokenEl.value = token;
}

function setDefaultDates() {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  routeStartDate.value ||= weekAgo.toISOString().slice(0, 10);
  routeEndDate.value ||= yesterday.toISOString().slice(0, 10);
}

function render(payload) {
  currentPayload = payload;
  document.getElementById("rangeText").textContent = payload.range ? `${payload.range.startDate} ~ ${payload.range.endDate}` : "-";
  document.getElementById("generatedAt").textContent = payload.generatedAt ? new Date(payload.generatedAt).toLocaleString("ko-KR") : "-";
  document.getElementById("rowCount").textContent = String(payload.rowCount || payload.rows?.length || 0);

  const columns = payload.columns || [];
  const rows = payload.rows || [];
  if (!columns.length) {
    const message = payload.warning || "아직 고정배차 캐시가 없습니다. 관리 토큰 저장 후 고정배차 갱신을 눌러주세요.";
    table.innerHTML = `<tbody><tr><td>${escapeHtml(message)}</td></tr></tbody>`;
    return;
  }

  table.innerHTML = `
    <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
    <tbody>
      ${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column] || "")}</td>`).join("")}</tr>`).join("")}
    </tbody>
  `;
}

function renderRouteStatus(state) {
  if (!state) {
    routeRefreshStatus.textContent = "-";
    return;
  }
  if (state.running) {
    const current = state.current ? ` / 현재 ${state.current.date} ${state.current.vehicle}` : "";
    routeRefreshStatus.textContent = `진행 중 ${state.completed}/${state.total}, 실패 ${state.failed}${current}`;
    return;
  }
  const finished = state.lastFinishedAt ? new Date(state.lastFinishedAt).toLocaleString("ko-KR") : "-";
  routeRefreshStatus.textContent = `대기 중 / 완료 ${state.completed || 0}/${state.total || 0}, 실패 ${state.failed || 0}, 마지막 완료 ${finished}${state.lastError ? ` / 최근 오류: ${state.lastError}` : ""}`;
}

async function loadStatus() {
  const response = await fetch("/api/status");
  if (!response.ok) return;
  const json = await response.json();
  renderRouteStatus(json.routeRefresh);
  if (json.routeRefresh?.running && !statusTimer) {
    statusTimer = setInterval(loadStatus, 4000);
  }
  if (!json.routeRefresh?.running && statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

async function loadData() {
  setStatus("목록 불러오는 중");
  const response = await fetch("/api/fixed-dispatch");
  render(await response.json());
  await loadStatus();
  setStatus("조회 완료");
}

async function refreshData() {
  const token = getToken();
  if (!token) {
    alert("고정배차 갱신은 관리 토큰이 필요합니다. 한 번 입력한 뒤 토큰 저장을 눌러두면 다음부터 자동 입력됩니다.");
    return;
  }
  saveToken();
  refreshButton.disabled = true;
  setStatus("Freshon 고정배차 갱신 중");
  try {
    const response = await fetch("/api/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": token
      },
      body: JSON.stringify({})
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "고정배차 갱신 실패");
    await loadData();
  } catch (error) {
    setStatus(`갱신 실패: ${error.message}`);
    alert(error.message);
  } finally {
    refreshButton.disabled = false;
  }
}

async function refreshRouteCache() {
  const token = getToken();
  if (!token) {
    alert("동선 캐시 갱신은 관리 토큰이 필요합니다. 한 번 입력한 뒤 토큰 저장을 눌러두면 다음부터 자동 입력됩니다.");
    return;
  }
  if (!routeStartDate.value || !routeEndDate.value) {
    alert("시작일과 종료일을 선택해주세요. 물류센터와 호차 목록은 비워두면 전체로 진행합니다.");
    return;
  }

  saveToken();
  routeRefreshButton.disabled = true;
  setStatus("동선 캐시 갱신 시작 중");
  try {
    const response = await fetch("/api/refresh-daily-routes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": token
      },
      body: JSON.stringify({
        startDate: routeStartDate.value,
        endDate: routeEndDate.value,
        center: routeCenter.value.trim(),
        vehicles: routeVehicles.value.trim()
      })
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "동선 캐시 갱신 실패");
    renderRouteStatus(json.routeRefresh);
    await loadStatus();
    setStatus("동선 캐시 갱신 진행 중");
  } catch (error) {
    setStatus(`동선 캐시 갱신 실패: ${error.message}`);
    alert(error.message);
  } finally {
    routeRefreshButton.disabled = false;
  }
}

function downloadCsv() {
  const columns = currentPayload.columns || [];
  const rows = currentPayload.rows || [];
  if (!columns.length) {
    alert("다운로드할 고정배차 목록이 없습니다. 먼저 고정배차 갱신을 실행해주세요.");
    return;
  }
  const csv = [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column] || "")).join(","))
  ].join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `freshon-fixed-dispatch-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

loadSavedToken();
setDefaultDates();
saveTokenButton.addEventListener("click", saveToken);
refreshButton.addEventListener("click", refreshData);
routeRefreshButton.addEventListener("click", refreshRouteCache);
reloadButton.addEventListener("click", loadData);
csvButton.addEventListener("click", downloadCsv);
loadData();
