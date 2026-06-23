(() => {
  const tokenInput = document.getElementById("admin-token");
  const refreshBtn = document.getElementById("refresh-all");
  const createForm = document.getElementById("create-form");
  const createResult = document.getElementById("create-result");
  const providerForm = document.getElementById("provider-form");
  const providerResult = document.getElementById("provider-result");
  const routeForm = document.getElementById("route-form");
  const routeResult = document.getElementById("route-result");
  const routeProviderSelect = document.getElementById("route-provider-id");
  const usageTenantInput = document.getElementById("usage-tenant");

  tokenInput.value = localStorage.getItem("tm.adminToken") || "";
  tokenInput.addEventListener("change", () => {
    localStorage.setItem("tm.adminToken", tokenInput.value.trim());
    void refreshAll();
  });

  function authHeaders() {
    const token = tokenInput.value.trim();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function adminFetch(path) {
    const res = await fetch(path, { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  function formatTime(iso) {
    if (!iso) {
      return "-";
    }
    return iso.replace("T", " ").slice(0, 19);
  }

  function renderEmpty(tbody, colspan, text) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="empty-row">${text}</td></tr>`;
  }

  function cell(text, mono = false) {
    const td = document.createElement("td");
    td.textContent = text ?? "-";
    if (mono) {
      td.className = "mono";
    }
    return td;
  }

  function outcomeBadge(outcome) {
    const td = document.createElement("td");
    const span = document.createElement("span");
    span.className = `badge ${outcome}`;
    span.textContent = outcome;
    td.appendChild(span);
    return td;
  }

  function renderProviderSelect(providers, preferredId) {
    const current = preferredId || routeProviderSelect.value;
    routeProviderSelect.innerHTML = "";
    routeProviderSelect.disabled = providers.length === 0;

    if (providers.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "请先配置 Provider";
      routeProviderSelect.appendChild(option);
      return;
    }

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "请选择 Provider";
    placeholder.disabled = true;
    placeholder.hidden = true;
    routeProviderSelect.appendChild(placeholder);

    for (const provider of providers) {
      const option = document.createElement("option");
      option.value = provider.providerId;
      option.textContent = `${provider.providerId} (${provider.providerType})`;
      routeProviderSelect.appendChild(option);
    }

    if (current && providers.some((provider) => provider.providerId === current)) {
      routeProviderSelect.value = current;
    } else {
      routeProviderSelect.selectedIndex = 1;
    }
  }

  async function loadProviders(preferredId) {
    const tbody = document.getElementById("providers-body");
    try {
      const data = await adminFetch("/admin/v1/providers");
      const providers = data.providers || [];
      renderProviderSelect(providers, preferredId);
      if (providers.length === 0) {
        renderEmpty(tbody, 4, "暂无上游 Provider");
        return;
      }
      tbody.innerHTML = "";
      for (const provider of providers) {
        const tr = document.createElement("tr");
        tr.appendChild(cell(provider.providerId, true));
        tr.appendChild(cell(provider.providerType));
        tr.appendChild(cell(provider.baseUrl, true));
        tr.appendChild(cell(provider.apiKeyMasked, true));
        tbody.appendChild(tr);
      }
    } catch (error) {
      renderEmpty(tbody, 4, `加载失败: ${error.message}`);
      renderProviderSelect([]);
    }
  }

  async function loadRoutes() {
    const tbody = document.getElementById("routes-body");
    try {
      const data = await adminFetch("/admin/v1/model-routes");
      const routes = data.modelRoutes || [];
      if (routes.length === 0) {
        renderEmpty(tbody, 3, "暂无模型路由");
        return;
      }
      tbody.innerHTML = "";
      for (const route of routes) {
        const tr = document.createElement("tr");
        tr.appendChild(cell(route.model, true));
        tr.appendChild(cell(route.providerId));
        tr.appendChild(cell(route.providerModel, true));
        tbody.appendChild(tr);
      }
    } catch (error) {
      renderEmpty(tbody, 3, `加载失败: ${error.message}`);
    }
  }

  async function loadUsage() {
    const tbody = document.getElementById("usage-body");
    const tenantId = usageTenantInput.value.trim() || "tenant-default";
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

  async function refreshAll() {
    await Promise.all([loadProviders(), loadRoutes(), loadUsage(), loadAudit()]);
  }

  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = {
      tenantId: document.getElementById("tenant-id").value.trim(),
      projectId: document.getElementById("project-id").value.trim()
    };
    const tenantName = document.getElementById("tenant-name").value.trim();
    const projectName = document.getElementById("project-name").value.trim();
    const tokenLimit = document.getElementById("token-limit").value;
    const costLimit = document.getElementById("cost-limit").value;
    if (tenantName) body.tenantName = tenantName;
    if (projectName) body.projectName = projectName;
    if (tokenLimit) body.tokenLimit = Number(tokenLimit);
    if (costLimit) body.costLimit = Number(costLimit);

    createResult.hidden = true;
    try {
      const res = await fetch("/admin/v1/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body)
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      createResult.className = "result-box success";
      createResult.innerHTML = "";
      const head = document.createElement("div");
      head.textContent = `已创建: ${payload.tenantId} / ${payload.projectId}`;
      const keyLine = document.createElement("div");
      keyLine.className = "key-line";
      keyLine.textContent = `API Key: ${payload.apiKey}`;
      createResult.append(head, keyLine);
      createResult.hidden = false;
      void refreshAll();
    } catch (error) {
      createResult.className = "result-box error";
      createResult.textContent = `创建失败: ${error.message}`;
      createResult.hidden = false;
    }
  });

  providerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = {
      providerId: document.getElementById("provider-id").value.trim(),
      providerType: document.getElementById("provider-type").value,
      baseUrl: document.getElementById("provider-base-url").value.trim(),
      apiKey: document.getElementById("provider-api-key").value.trim()
    };

    providerResult.hidden = true;
    try {
      const res = await fetch("/admin/v1/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body)
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }

      providerResult.className = "result-box success";
      providerResult.textContent = `Provider 已保存: ${payload.provider.providerId} (${payload.provider.providerType})`;
      providerResult.hidden = false;
      document.getElementById("provider-api-key").value = "";
      void loadProviders(payload.provider.providerId);
    } catch (error) {
      providerResult.className = "result-box error";
      providerResult.textContent = `保存失败: ${error.message}`;
      providerResult.hidden = false;
    }
  });

  routeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = {
      model: document.getElementById("route-model").value.trim(),
      providerId: document.getElementById("route-provider-id").value.trim(),
      providerModel: document.getElementById("route-provider-model").value.trim()
    };

    routeResult.hidden = true;
    try {
      const res = await fetch("/admin/v1/model-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body)
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const details = payload.supportedProviders?.length
          ? `（可用: ${payload.supportedProviders.join(", ")}）`
          : "";
        throw new Error(`${payload.error || `HTTP ${res.status}`}${details}`);
      }

      routeResult.className = "result-box success";
      routeResult.textContent = `模型已添加: ${payload.modelRoute.model} -> ${payload.modelRoute.providerId}/${payload.modelRoute.providerModel}`;
      routeResult.hidden = false;
      routeForm.reset();
      void loadRoutes();
    } catch (error) {
      routeResult.className = "result-box error";
      routeResult.textContent = `添加失败: ${error.message}`;
      routeResult.hidden = false;
    }
  });

  refreshBtn.addEventListener("click", () => void refreshAll());
  usageTenantInput.addEventListener("change", () => void loadUsage());

  void refreshAll();
})();
