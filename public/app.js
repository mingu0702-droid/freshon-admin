let currentPayload = { columns: [], rows: [] };

const statusEl = document.getElementById("status");
const tokenEl = document.getElementById("adminToken");
const refreshButton = document.getElementById("refreshButton");
const reloadButton = document.getElementById("reloadButton");
const csvButton = document.getElementById("csvButton");
const table = document.getElementById("dataTable");

function setStatus(text) {
  statusEl.textContent = text;
}

function render(payload) {
  currentPayload = payload;
  document.getElementById("rangeText").textContent = payload.range ? `${payload.range.startDate} ~ ${payload.range.endDate}` : "-";
  document.getElementById("generatedAt").textContent = payload.generatedAt ? new Date(payload.generatedAt).toLocaleString("ko-KR") : "-";
  document.getElementById("rowCount").textContent = String(payload.rowCount || payload.rows?.length || 0);

  const columns = payload.columns || [];
  const rows = payload.rows || [];
  if (!columns.length) {
    table.innerHTML = `<tbody><tr><td>${payload.warning || "데이터가 없습니다."}</td></tr></tbody>`;
    return;
  }

  table.innerHTML = `
    <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
    <tbody>
      ${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column] || "")}</td>`).join("")}</tr>`).join("")}
    </tbody>
  `;
}

async function loadData() {
  setStatus("목록 불러오는 중");
  const response = await fetch("/api/fixed-dispatch");
  render(await response.json());
  setStatus("조회 완료");
}

async function refreshData() {
  const token = tokenEl.value.trim();
  if (!token) {
    alert("데이터 갱신은 관리 토큰이 필요합니다.");
    return;
  }
  refreshButton.disabled = true;
  setStatus("Freshon 데이터 갱신 중");
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
    if (!response.ok) throw new Error(json.error || "Refresh failed");
    await loadData();
  } catch (error) {
    setStatus(`갱신 실패: ${error.message}`);
    alert(error.message);
  } finally {
    refreshButton.disabled = false;
  }
}

function downloadCsv() {
  const columns = currentPayload.columns || [];
  const rows = currentPayload.rows || [];
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

refreshButton.addEventListener("click", refreshData);
reloadButton.addEventListener("click", loadData);
csvButton.addEventListener("click", downloadCsv);
loadData();
