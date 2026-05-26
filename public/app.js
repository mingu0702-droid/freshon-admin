let currentPayload = { columns: [], rows: [] };

const TOKEN_KEY = "freshonAdminToken";

const statusEl = document.getElementById("status");
const tokenEl = document.getElementById("adminToken");
const saveTokenButton = document.getElementById("saveTokenButton");
const reloadButton = document.getElementById("reloadButton");
const csvButton = document.getElementById("csvButton");
const uploadButton = document.getElementById("uploadButton");
const fileInput = document.getElementById("fixedDispatchFiles");
const uploadStatus = document.getElementById("uploadStatus");
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

function render(payload) {
  currentPayload = payload;
  document.getElementById("rangeText").textContent = payload.range ? `${payload.range.startDate} ~ ${payload.range.endDate}` : "-";
  document.getElementById("generatedAt").textContent = payload.generatedAt ? new Date(payload.generatedAt).toLocaleString("ko-KR") : "-";
  document.getElementById("rowCount").textContent = String(payload.rowCount || payload.rows?.length || 0);

  const columns = payload.columns || [];
  const rows = payload.rows || [];
  if (!columns.length) {
    const message = payload.warning || "아직 고정배차 캐시가 없습니다. 월별 엑셀 파일을 업로드해 주세요.";
    table.innerHTML = `<tbody><tr><td>${escapeHtml(message)}</td></tr></tbody>`;
    return;
  }

  const previewRows = rows.slice(0, 500);
  table.innerHTML = `
    <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
    <tbody>
      ${previewRows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column] || "")}</td>`).join("")}</tr>`).join("")}
    </tbody>
  `;
  uploadStatus.textContent = rows.length > previewRows.length
    ? `저장 완료. 화면에는 ${previewRows.length.toLocaleString("ko-KR")}행만 미리보기로 표시합니다.`
    : "저장 완료.";
}

async function loadStatus() {
  const response = await fetch("/api/status");
  if (!response.ok) return null;
  const json = await response.json();
  if (json.refresh?.running) {
    setStatus("엑셀 저장 진행 중입니다.");
  } else if (json.refresh?.lastError) {
    setStatus(`최근 저장 실패: ${json.refresh.lastError}`);
  }
  return json;
}

async function loadData() {
  setStatus("목록 불러오는 중");
  const response = await fetch("/api/fixed-dispatch");
  render(await response.json());
  await loadStatus();
  setStatus("조회 완료");
}

async function uploadFixedDispatchFiles() {
  const token = getToken();
  if (!token) {
    alert("엑셀 업로드 저장은 관리 토큰이 필요합니다. 토큰을 입력하고 저장해 주세요.");
    return;
  }
  const files = [...fileInput.files];
  if (!files.length) {
    alert("업로드할 엑셀 파일을 선택해 주세요.");
    return;
  }

  saveToken();
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));

  uploadButton.disabled = true;
  uploadStatus.textContent = `${files.length}개 파일 업로드 중...`;
  setStatus("엑셀 업로드 저장 중");

  try {
    const response = await fetch("/api/upload-fixed-dispatch", {
      method: "POST",
      headers: {
        "x-admin-token": token
      },
      body: formData
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "엑셀 업로드 저장 실패");
    uploadStatus.textContent = `업로드 ${json.uploadedRows.toLocaleString("ko-KR")}행, 전체 저장 ${json.rowCount.toLocaleString("ko-KR")}행`;
    await loadData();
  } catch (error) {
    uploadStatus.textContent = `실패: ${error.message}`;
    setStatus(`엑셀 업로드 저장 실패: ${error.message}`);
    alert(error.message);
  } finally {
    uploadButton.disabled = false;
  }
}

function downloadCsv() {
  const columns = currentPayload.columns || [];
  const rows = currentPayload.rows || [];
  if (!columns.length) {
    alert("다운로드할 고정배차 목록이 없습니다. 먼저 엑셀 파일을 업로드해 주세요.");
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
saveTokenButton.addEventListener("click", saveToken);
reloadButton.addEventListener("click", loadData);
csvButton.addEventListener("click", downloadCsv);
uploadButton.addEventListener("click", uploadFixedDispatchFiles);
loadData();

