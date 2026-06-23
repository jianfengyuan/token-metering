import { adminFetch, cell, formatTime, outcomeBadge, renderEmpty } from "./utils.js";

export function initMonitoringTab() {
  const usageTenantInput = document.getElementById("usage-tenant");

  usageTenantInput.addEventListener("change", () => void loadUsage());

  return {
    refresh: async () => {
      await loadUsage();
      await loadAudit();
    }
  };
}

async function loadUsage() {
  const tbody = document.getElementById("usage-body");
  const tenantId = document.getElementById("usage-tenant").value.trim() || "tenant-default";
  try {
    const data = await adminFetch(`/admin/v1/usage?tenantId=${encodeURIComponent(tenantId)}`);
    const summary = data.summary || {};
    document.getElementById("stat-count").textContent = summary.count ?? "-";
    document.getElementById("stat-prompt").textContent = (summary.promptTokens ?? 0).toLocaleString();
    document.getElementById("stat-completion").textContent = (summary.completionTokens ?? 0).toLocaleString();
    document.getElementById("stat-cost").textContent =
      `${(summary.totalCost ?? 0).toFixed(4)} ${summary.currency || "USD"}`;

    const records = data.records || [];
    if (records.length === 0) {
      renderEmpty(tbody, 7, "暂无用量记录");
      return;
    }
    tbody.innerHTML = "";
    for (const record of records) {
      const tr = document.createElement("tr");
      tr.appendChild(cell(formatTime(record.createdAt), true));
      tr.appendChild(cell(record.projectId, true));
      tr.appendChild(cell(record.model, true));
      tr.appendChild(cell(record.provider));
      tr.appendChild(cell(String(record.usage?.totalTokens ?? record.totalTokensActual ?? "-")));
      tr.appendChild(cell((record.cost?.totalCost ?? 0).toFixed(6), true));
      tr.appendChild(cell(record.status));
      tbody.appendChild(tr);
    }
  } catch (error) {
    renderEmpty(tbody, 7, `加载失败: ${error.message}`);
    for (const id of ["stat-count", "stat-prompt", "stat-completion", "stat-cost"]) {
      document.getElementById(id).textContent = "-";
    }
  }
}

async function loadAudit() {
  const tbody = document.getElementById("audit-body");
  try {
    const data = await adminFetch("/admin/v1/audit-events?limit=50");
    const events = data.events || [];
    if (events.length === 0) {
      renderEmpty(tbody, 6, "暂无审计事件");
      return;
    }
    tbody.innerHTML = "";
    for (const event of events) {
      const tr = document.createElement("tr");
      tr.appendChild(cell(formatTime(event.createdAt), true));
      tr.appendChild(cell(event.eventType, true));
      tr.appendChild(outcomeBadge(event.outcome));
      tr.appendChild(cell(event.tenantId, true));
      tr.appendChild(cell(event.model, true));
      tr.appendChild(cell(event.errorCode, true));
      tbody.appendChild(tr);
    }
  } catch (error) {
    renderEmpty(tbody, 6, `加载失败: ${error.message}`);
  }
}
