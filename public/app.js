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
  setStatus("관리 토큰을 이 브라우저에 기억했습니다.");
}

function loadSavedToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) tokenEl.value = token;
}

function render(payload) {
  currentPayload = payload || { columns: [], rows: [] };
  document.getElementById("rangeText").textContent = currentPayload.range ? `${currentPayload.range.startDate} ~ ${currentPayload.range.endDate}` : "-";
  document.getElementById("generatedAt").textContent = currentPayload.generatedAt ? new Date(currentPayload.generatedAt).toLocaleString("ko-KR") : "-";
  document.getElementById("rowCount").textContent = String(currentPayload.rowCount || currentPayload.rows?.length || 0);

  const columns = currentPayload.columns || [];
  const rows = currentPayload.rows || [];
  if (!columns.length) {
    const message = currentPayload.warning || "아직 고정배차 캐시가 없습니다. 월별 엑셀 파일을 업로드해주세요.";
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
    setStatus("작업 저장 진행 중입니다.");
  } else if (json.refresh?.lastError) {
    setStatus(`최근 저장 실패: ${json.refresh.lastError}`);
  }
  return json;
}

async function loadData() {
  setStatus("저장자료 불러오는 중");
  const response = await fetch("/api/fixed-dispatch");
  render(await response.json());
  await loadStatus();
  setStatus("조회 완료");
}

async function uploadFixedDispatchFiles() {
  const token = getToken();
  if (!token) {
    alert("관리 토큰을 먼저 입력해주세요. 한 번 저장하면 다음부터는 자동으로 불러옵니다.");
    return;
  }
  const files = [...fileInput.files];
  if (!files.length) {
    alert("업로드할 엑셀 파일을 선택해주세요.");
    return;
  }

  saveToken();
  uploadButton.disabled = true;
  setStatus("엑셀 저장 진행 중");
  const startedAt = Date.now();
  let uploadedRows = 0;
  let finalRowCount = 0;

  try {
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const done = i;
      const avgSeconds = done ? elapsedSeconds / done : null;
      const remainSeconds = avgSeconds ? Math.max(1, Math.round(avgSeconds * (files.length - done))) : null;
      uploadStatus.textContent = `${i + 1}/${files.length} 저장 중: ${file.name}${remainSeconds ? ` · 예상 남은 시간 ${remainSeconds}초` : " · 남은 시간 계산 중"}`;

      const formData = new FormData();
      formData.append("files", file);
      const response = await fetch("/api/upload-fixed-dispatch", {
        method: "POST",
        headers: { "x-admin-token": token },
        body: formData
      });

      const responseText = await response.text();
      let json = {};
      if (responseText) {
        try {
          json = JSON.parse(responseText);
        } catch (_error) {
          throw new Error(`서버 응답을 읽지 못했습니다. ${file.name} 파일이 너무 크거나 서버가 처리 중에 끊겼을 수 있습니다.`);
        }
      }
      if (!response.ok) throw new Error(json.error || `${file.name} 저장 실패`);
      uploadedRows += Number(json.uploadedRows || 0);
      finalRowCount = Number(json.rowCount || finalRowCount || 0);
    }
    const totalSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    uploadStatus.textContent = `저장 완료 · 업로드 ${uploadedRows.toLocaleString("ko-KR")}행 · 전체 ${finalRowCount.toLocaleString("ko-KR")}행 · 총 ${totalSeconds}초`;
    await loadData();
  } catch (error) {
    uploadStatus.textContent = `실패: ${error.message}`;
    setStatus(`엑셀 저장 실패: ${error.message}`);
    alert(error.message);
  } finally {
    uploadButton.disabled = false;
  }
}

function downloadCsv() {
  const columns = currentPayload.columns || [];
  const rows = currentPayload.rows || [];
  if (!columns.length) {
    alert("받을 고정배차 목록이 없습니다. 먼저 엑셀 파일을 업로드해주세요.");
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
