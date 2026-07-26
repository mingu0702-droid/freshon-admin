let currentPayload = { columns: [], rows: [] };
let uploadRunning = false;
let remoteSearchTimer = null;
let remoteSearchResults = [];

const TOKEN_KEY = "freshonAdminToken";
const statusEl = document.getElementById("status");
const tokenEl = document.getElementById("adminToken");
const saveTokenButton = document.getElementById("saveTokenButton");
const reloadButton = document.getElementById("reloadButton");
const csvButton = document.getElementById("csvButton");
const uploadButton = document.getElementById("uploadButton");
const sheetSyncButton = document.getElementById("sheetSyncButton");
const fileInput = document.getElementById("fixedDispatchFiles");
const uploadStatus = document.getElementById("uploadStatus");
const table = document.getElementById("dataTable");
const adminSearchInput = document.getElementById("adminSearchInput");
const clearSearchButton = document.getElementById("clearSearchButton");
const adminSearchCards = document.getElementById("adminSearchCards");

const HIDDEN_COLUMN_RE = /(출입문|잠금|특이사항|배송요청|요청사항|door|lock|request|note|memo)/i;

window.addEventListener("beforeunload", (event) => {
  if (!uploadRunning) return;
  event.preventDefault();
  event.returnValue = "";
});

function setStatus(text) {
  statusEl.textContent = text;
}

function getToken() {
  return tokenEl.value.trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeSearchText(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, "").replace(/[()]/g, "");
}

function formatSeconds(seconds) {
  const value = Math.max(0, Math.round(seconds || 0));
  if (value < 60) return `${value}초`;
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${minutes}분 ${rest}초` : `${minutes}분`;
}

function visibleColumns(columns = []) {
  return columns.filter((column) => !String(column).startsWith("_") && !HIDDEN_COLUMN_RE.test(String(column)));
}

function sortRowsBySavedOrder(rows = []) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = Number(a.row?._savedOrder || 0);
      const right = Number(b.row?._savedOrder || 0);
      if (left && right) return left - right;
      if (left) return -1;
      if (right) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

function getSearchFilteredRows(rows = []) {
  const query = normalizeSearchText(adminSearchInput?.value || "");
  if (!query) return sortRowsBySavedOrder(rows);
  return sortRowsBySavedOrder(rows).filter((row) => normalizeSearchText(Object.values(row || {}).join(" ")).includes(query));
}

function firstRowValue(row, names) {
  const entries = Object.entries(row || {});
  for (const name of names) {
    const target = normalizeSearchText(name);
    const found = entries.find(([key, value]) => normalizeSearchText(key).includes(target) && String(value ?? "").trim());
    if (found) return String(found[1]).trim();
  }
  return "";
}

function normalizeSearchItem(item) {
  return {
    code: item.code || item.customerCode || firstRowValue(item, ["고객ERP코드", "고객코드", "ERP코드", "매장코드", "고객"]),
    name: item.name || item.customerName || firstRowValue(item, ["고객명", "업체명", "매장명", "상호"]),
    address: item.address || firstRowValue(item, ["고객주소", "주소", "배송주소"]),
    vehicle: item.vehicle || firstRowValue(item, ["기준호차", "확정호차", "호차", "배송호차"]),
    route: item.route || item.center || firstRowValue(item, ["물류센터", "센터"]),
    source: item.source || item._sourceFile || ""
  };
}

function adminCardHtml(row) {
  const item = normalizeSearchItem(row);
  const title = item.code ? `${item.code} / ${item.name || "-"}` : item.name || "-";
  return `
    <article class="admin-store-card">
      <strong>${escapeHtml(title)}</strong>
      <span class="pill">${escapeHtml(item.vehicle ? `${item.vehicle}호` : "호차 없음")}</span>
      ${item.route ? `<span class="pill">${escapeHtml(item.route)}</span>` : ""}
      <small>${escapeHtml(item.address || "-")}</small>
      ${item.source ? `<small>출처: ${escapeHtml(item.source)}</small>` : ""}
    </article>
  `;
}

async function readJsonResponse(response, label = "요청") {
  const text = await response.text();
  if (!text.trim()) {
    if (response.ok) return {};
    throw new Error(`${label} 실패 · HTTP ${response.status} · 서버 응답이 비어 있습니다.`);
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    const preview = text.replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`${label} 실패 · HTTP ${response.status} · JSON 응답이 아닙니다: ${preview || "empty response"}`);
  }
}

function render(payload = currentPayload) {
  currentPayload = payload || { columns: [], rows: [] };
  const allRows = currentPayload.rows || [];
  const filteredRows = getSearchFilteredRows(allRows);
  const hasSearch = !!adminSearchInput?.value.trim();

  document.getElementById("rangeText").textContent = currentPayload.range ? `${currentPayload.range.startDate} ~ ${currentPayload.range.endDate}` : "-";
  document.getElementById("generatedAt").textContent = currentPayload.generatedAt ? new Date(currentPayload.generatedAt).toLocaleString("ko-KR") : "-";
  document.getElementById("rowCount").textContent = hasSearch
    ? `${filteredRows.length.toLocaleString("ko-KR")} / ${allRows.length.toLocaleString("ko-KR")}`
    : String(currentPayload.rowCount || allRows.length || 0);

  if (adminSearchCards) {
    const cardRows = hasSearch ? (filteredRows.length ? filteredRows : remoteSearchResults) : [];
    adminSearchCards.classList.toggle("active", hasSearch);
    adminSearchCards.innerHTML = hasSearch
      ? cardRows.slice(0, 30).map(adminCardHtml).join("") || `<article class="admin-store-card"><strong>검색 결과가 없습니다.</strong><small>다른 검색어를 입력해주세요.</small></article>`
      : "";
  }

  const columns = visibleColumns(currentPayload.columns || []);
  if (!columns.length) {
    table.innerHTML = `<tbody><tr><td>${escapeHtml(currentPayload.warning || "아직 고정배차 캐시가 없습니다. 월별 엑셀 파일을 업로드해주세요.")}</td></tr></tbody>`;
    return;
  }
  const previewRows = filteredRows.slice(0, 500);
  table.innerHTML = `
    <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
    <tbody>${previewRows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column] || "")}</td>`).join("")}</tr>`).join("")}</tbody>
  `;
  uploadStatus.textContent = filteredRows.length > previewRows.length
    ? `저장 완료. 화면에는 ${previewRows.length.toLocaleString("ko-KR")}행만 미리보기로 표시합니다.`
    : "저장 완료.";
}

async function loadStatus() {
  const response = await fetch("/api/status");
  if (!response.ok) return null;
  const json = await readJsonResponse(response, "상태 조회");
  const sync = json.refresh?.googleSheetSync;
  if (json.refresh?.running) setStatus("저장 작업이 진행 중입니다.");
  else if (json.refresh?.lastError) setStatus(`최근 저장 실패: ${json.refresh.lastError}`);
  else if (sync && !sync.skipped) setStatus(`저장 완료 · 구글시트 ${sync.rows?.toLocaleString("ko-KR") || 0}행 동기화`);
  return json;
}

async function loadData(options = {}) {
  const silent = Boolean(options.silent);
  try {
    setStatus("???? ???? ?");
    const response = await fetch("/api/fixed-dispatch?limit=500");
    render(await readJsonResponse(response, "???? ??"));
    await loadStatus();
    setStatus("?? ??");
    return true;
  } catch (error) {
    await loadStatus().catch(() => null);
    const message = `???? ?? ??: ${error.message}`;
    setStatus(message);
    if (!silent) uploadStatus.textContent = message;
    return false;
  }
}

async function refreshRemoteSearch() {
  const q = adminSearchInput?.value.trim() || "";
  if (!q) {
    remoteSearchResults = [];
    render();
    return;
  }
  try {
    const response = await fetch(`/api/fixed-dispatch/customer-search?q=${encodeURIComponent(q)}`);
    const json = await readJsonResponse(response, "검색");
    remoteSearchResults = Array.isArray(json.results) ? json.results : [];
  } catch (_error) {
    remoteSearchResults = [];
  }
  render();
}

function saveToken() {
  const token = getToken();
  if (!token) {
    localStorage.removeItem(TOKEN_KEY);
    setStatus("저장된 관리 토큰을 지웠습니다.");
    return;
  }
  localStorage.setItem(TOKEN_KEY, token);
  setStatus("관리 토큰을 브라우저에 저장했습니다.");
}

function loadSavedToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) tokenEl.value = token;
}

async function postUploadChunk(formData, token, fileName, attempt = 1) {
  const response = await fetch("/api/upload-fixed-dispatch-chunk", {
    method: "POST",
    headers: { "x-admin-token": token },
    body: formData
  });
  if ([502, 503, 504, 524].includes(response.status) && attempt < 12) {
    uploadStatus.textContent = `${fileName} 업로드 재시도 중 · HTTP ${response.status} · ${attempt}/12`;
    await new Promise((resolve) => setTimeout(resolve, 1800 * attempt));
    return postUploadChunk(formData, token, fileName, attempt + 1);
  }
  return readJsonResponse(response, `${fileName} 업로드`);
}

async function waitForUploadJob(jobId, fileName, startedAt) {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const status = await loadStatus();
    const refresh = status?.refresh || {};
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (refresh.running) {
      uploadStatus.textContent = `${fileName} 서버 저장 중 · 경과 ${formatSeconds(elapsed)}`;
      continue;
    }
    if (refresh.lastError) throw new Error(refresh.lastError);
    return refresh;
  }
}

async function uploadFile(file, token) {
  const startedAt = Date.now();
  const chunkSize = 128 * 1024;
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
  const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let result = null;
  for (let index = 0; index < totalChunks; index += 1) {
    const formData = new FormData();
    formData.append("uploadId", uploadId);
    formData.append("index", String(index));
    formData.append("totalChunks", String(totalChunks));
    formData.append("fileName", file.name);
    formData.append("fileSize", String(file.size));
    formData.append("chunk", file.slice(index * chunkSize, Math.min(file.size, (index + 1) * chunkSize)), file.name);
    uploadStatus.textContent = `${file.name} 업로드 중 · ${index + 1}/${totalChunks}`;
    result = await postUploadChunk(formData, token, file.name);
  }
  if (result?.jobId) await waitForUploadJob(result.jobId, file.name, startedAt);
}

async function uploadFiles() {
  const token = getToken();
  const files = [...fileInput.files];
  if (!token) return alert("관리 토큰을 입력해주세요.");
  if (!files.length) return alert("업로드할 엑셀 파일을 선택해주세요.");
  uploadRunning = true;
  uploadButton.disabled = true;
  try {
    for (const file of files) await uploadFile(file, token);
    await loadData({ silent: true });
    setStatus("저장 완료");
  } catch (error) {
    uploadStatus.textContent = `저장 실패: ${error.message}`;
    setStatus("저장 실패");
    alert(error.message);
  } finally {
    uploadRunning = false;
    uploadButton.disabled = false;
  }
}

async function syncCurrentSheet() {
  const token = getToken();
  if (!token) return alert("관리 토큰을 입력해주세요.");
  sheetSyncButton.disabled = true;
  setStatus("구글시트 동기화 중");
  try {
    const response = await fetch("/api/fixed-dispatch/sync-google-sheet", {
      method: "POST",
      headers: { "x-admin-token": token }
    });
    const json = await readJsonResponse(response, "구글시트 동기화");
    setStatus(`구글시트 동기화 완료 · ${json.googleSheetSync?.rows?.toLocaleString("ko-KR") || 0}행`);
    await loadStatus();
  } catch (error) {
    setStatus(`구글시트 동기화 실패: ${error.message}`);
    alert(error.message);
  } finally {
    sheetSyncButton.disabled = false;
  }
}

function downloadCsv() {
  const rows = getSearchFilteredRows(currentPayload.rows || []);
  const columns = visibleColumns(currentPayload.columns || []);
  const csv = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => `"${String(row[column] || "").replaceAll('"', '""')}"`).join(","))
  ].join("\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `freshon-fixed-dispatch-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

saveTokenButton.addEventListener("click", saveToken);
reloadButton.addEventListener("click", loadData);
csvButton.addEventListener("click", downloadCsv);
uploadButton.addEventListener("click", uploadFiles);
sheetSyncButton.addEventListener("click", syncCurrentSheet);
clearSearchButton.addEventListener("click", () => {
  adminSearchInput.value = "";
  remoteSearchResults = [];
  render();
});
adminSearchInput.addEventListener("input", () => {
  window.clearTimeout(remoteSearchTimer);
  remoteSearchTimer = window.setTimeout(refreshRemoteSearch, 250);
  render();
});

loadSavedToken();
loadStatus().catch((error) => {
  setStatus(`상태 조회 실패: ${error.message}`);
});
