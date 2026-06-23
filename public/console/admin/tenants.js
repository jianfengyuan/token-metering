import {
  adminFetch,
  adminPost,
  bindForm,
  cell,
  fillSelect,
  formatTime,
  renderEmpty,
  showResult
} from "./utils.js";

async function loadTenantOptions() {
  const select = document.getElementById("add-project-tenant-id");
  try {
    const data = await adminFetch("/admin/v1/tenants");
    const tenants = data.tenants || [];
    fillSelect(
      select,
      tenants.map((tenant) => ({
        value: tenant.id,
        label: tenant.name ? `${tenant.name} (${tenant.id})` : tenant.id
      })),
      tenants.length === 0 ? "暂无租户，请先开通" : "请选择租户"
    );
  } catch (error) {
    fillSelect(select, [], `加载失败: ${error.message}`);
  }
}

async function loadProjectOptions(preferredProjectId) {
  const addKeySelect = document.getElementById("add-key-project-id");
  const keysSelect = document.getElementById("keys-project-id");
  const previousKeysProjectId = preferredProjectId ?? keysSelect?.value ?? "";

  try {
    const tenantData = await adminFetch("/admin/v1/tenants");
    const tenants = tenantData.tenants || [];
    const allProjects = [];

    for (const tenant of tenants) {
      const projectData = await adminFetch(`/admin/v1/tenants/${encodeURIComponent(tenant.id)}/projects`);
      for (const project of projectData.projects || []) {
        allProjects.push({
          id: project.id,
          name: project.name,
          tenantId: tenant.id,
          tenantName: tenant.name
        });
      }
    }

    const options = allProjects.map((project) => {
      const tenantLabel = project.tenantName || project.tenantId;
      const projectLabel = project.name ? `${project.name} (${project.id})` : project.id;
      return {
        value: project.id,
        label: `${projectLabel} · ${tenantLabel}`
      };
    });

    const placeholder = allProjects.length === 0 ? "暂无项目，请先添加" : "请选择项目";
    fillSelect(addKeySelect, options, placeholder);
    fillSelect(keysSelect, options, placeholder);

    if (previousKeysProjectId && options.some((option) => option.value === previousKeysProjectId)) {
      keysSelect.value = previousKeysProjectId;
      addKeySelect.value = previousKeysProjectId;
    }
  } catch (error) {
    fillSelect(addKeySelect, [], `加载失败: ${error.message}`);
    fillSelect(keysSelect, [], `加载失败: ${error.message}`);
  }
}

export function initTenantsTab() {
  const provisionForm = document.getElementById("provision-form");
  const provisionResult = document.getElementById("provision-result");
  const addProjectForm = document.getElementById("add-project-form");
  const addProjectResult = document.getElementById("add-project-result");
  const addKeyForm = document.getElementById("add-key-form");
  const addKeyResult = document.getElementById("add-key-result");
  const keysProjectInput = document.getElementById("keys-project-id");

  bindForm(provisionForm, async () => {
    provisionResult.hidden = true;
    const body = {
      tenantId: document.getElementById("provision-tenant-id").value.trim(),
      projectId: document.getElementById("provision-project-id").value.trim()
    };
    const tenantName = document.getElementById("provision-tenant-name").value.trim();
    const projectName = document.getElementById("provision-project-name").value.trim();
    if (tenantName) body.tenantName = tenantName;
    if (projectName) body.projectName = projectName;

    try {
      const payload = await adminPost("/admin/v1/tenants/provision", body);
      showResult(
        provisionResult,
        true,
        `已开通: ${payload.tenantId} / ${payload.projectId}`,
        payload.apiKey
      );
      keysProjectInput.value = payload.projectId;
      await refreshTenantsTab(payload.projectId);
    } catch (error) {
      showResult(provisionResult, false, `开通失败: ${error.message}`);
    }
  });

  bindForm(addProjectForm, async () => {
    addProjectResult.hidden = true;
    const tenantId = document.getElementById("add-project-tenant-id").value.trim();
    if (!tenantId) {
      showResult(addProjectResult, false, "请先选择租户");
      return;
    }
    const body = {
      projectId: document.getElementById("add-project-id").value.trim()
    };
    const projectName = document.getElementById("add-project-name").value.trim();
    if (projectName) body.projectName = projectName;

    try {
      const payload = await adminPost(`/admin/v1/tenants/${encodeURIComponent(tenantId)}/projects`, body);
      showResult(
        addProjectResult,
        true,
        `项目已创建: ${payload.projectId}`,
        payload.apiKey
      );
      keysProjectInput.value = payload.projectId;
      await refreshTenantsTab(payload.projectId);
    } catch (error) {
      showResult(addProjectResult, false, `创建失败: ${error.message}`);
    }
  });

  bindForm(addKeyForm, async () => {
    addKeyResult.hidden = true;
    const projectId = document.getElementById("add-key-project-id").value.trim();
    if (!projectId) {
      showResult(addKeyResult, false, "请先选择项目");
      return;
    }
    try {
      const payload = await adminPost(`/admin/v1/projects/${encodeURIComponent(projectId)}/api-keys`, {});
      showResult(addKeyResult, true, `Key 已生成: ${payload.apiKeyId}`, payload.apiKey);
      keysProjectInput.value = projectId;
      await loadApiKeys(projectId);
    } catch (error) {
      showResult(addKeyResult, false, `生成失败: ${error.message}`);
    }
  });

  keysProjectInput.addEventListener("change", () => {
    const projectId = keysProjectInput.value.trim();
    if (projectId) {
      document.getElementById("add-key-project-id").value = projectId;
      void loadApiKeys(projectId);
    } else {
      renderEmpty(document.getElementById("keys-body"), 5, "请选择项目");
    }
  });

  return {
    refresh: refreshTenantsTab
  };
}

async function refreshTenantsTab(preferredProjectId) {
  await loadTenants();
  await loadTenantOptions();
  await loadProjectOptions(preferredProjectId);
  const projectId = preferredProjectId ?? document.getElementById("keys-project-id")?.value.trim();
  if (projectId) {
    await loadApiKeys(projectId);
  } else {
    renderEmpty(document.getElementById("keys-body"), 5, "请选择项目");
  }
}

async function loadTenants() {
  const tbody = document.getElementById("tenants-body");
  try {
    const data = await adminFetch("/admin/v1/tenants");
    const tenants = data.tenants || [];
    if (tenants.length === 0) {
      renderEmpty(tbody, 4, "暂无租户");
      return;
    }
    tbody.innerHTML = "";
    for (const tenant of tenants) {
      const tr = document.createElement("tr");
      tr.appendChild(cell(tenant.id, true));
      tr.appendChild(cell(tenant.name));
      tr.appendChild(cell(tenant.status));
      tr.appendChild(cell(formatTime(tenant.createdAt), true));
      tbody.appendChild(tr);
    }
  } catch (error) {
    renderEmpty(tbody, 4, `加载失败: ${error.message}`);
  }
}

async function loadApiKeys(projectId) {
  const tbody = document.getElementById("keys-body");
  try {
    const data = await adminFetch(`/admin/v1/projects/${encodeURIComponent(projectId)}/api-keys`);
    const keys = data.apiKeys || [];
    if (keys.length === 0) {
      renderEmpty(tbody, 5, "暂无 API Key");
      return;
    }
    tbody.innerHTML = "";
    for (const key of keys) {
      const tr = document.createElement("tr");
      tr.appendChild(cell(key.keyPrefix, true));
      tr.appendChild(cell(key.status));
      tr.appendChild(cell(key.scope));
      tr.appendChild(cell(formatTime(key.lastUsedAt), true));
      const actions = document.createElement("td");
      const row = document.createElement("div");
      row.className = "btn-row";
      if (key.status === "active" && !key.revokedAt) {
        const revokeBtn = document.createElement("button");
        revokeBtn.type = "button";
        revokeBtn.className = "secondary small danger";
        revokeBtn.textContent = "吊销";
        revokeBtn.addEventListener("click", () => void revokeKey(key.id, projectId));
        row.appendChild(revokeBtn);
        const rotateBtn = document.createElement("button");
        rotateBtn.type = "button";
        rotateBtn.className = "secondary small";
        rotateBtn.textContent = "轮换";
        rotateBtn.addEventListener("click", () => void rotateKey(key.id, projectId));
        row.appendChild(rotateBtn);
      }
      actions.appendChild(row);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    }
  } catch (error) {
    renderEmpty(tbody, 5, `加载失败: ${error.message}`);
  }
}

async function revokeKey(apiKeyId, projectId) {
  await adminPost(`/admin/v1/api-keys/${encodeURIComponent(apiKeyId)}/revoke`, {});
  await loadApiKeys(projectId);
}

async function rotateKey(apiKeyId, projectId) {
  const payload = await adminPost(`/admin/v1/api-keys/${encodeURIComponent(apiKeyId)}/rotate`, {});
  alert(`新 API Key（仅显示一次）:\n${payload.apiKey}`);
  await loadApiKeys(projectId);
}
