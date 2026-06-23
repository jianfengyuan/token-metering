import { adminFetch, adminPost, bindForm, cell, renderEmpty, showResult } from "./utils.js";

export function initPlatformTab() {
  const providerForm = document.getElementById("provider-form");
  const providerResult = document.getElementById("provider-result");
  const routeForm = document.getElementById("route-form");
  const routeResult = document.getElementById("route-result");
  const routeProviderSelect = document.getElementById("route-provider-id");

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

  bindForm(providerForm, async () => {
    providerResult.hidden = true;
    const body = {
      providerId: document.getElementById("provider-id").value.trim(),
      providerType: document.getElementById("provider-type").value,
      baseUrl: document.getElementById("provider-base-url").value.trim(),
      apiKey: document.getElementById("provider-api-key").value.trim()
    };

    try {
      const payload = await adminPost("/admin/v1/providers", body);
      showResult(
        providerResult,
        true,
        `Provider 已保存: ${payload.provider.providerId} (${payload.provider.providerType})`
      );
      document.getElementById("provider-api-key").value = "";
      await loadProviders(payload.provider.providerId);
    } catch (error) {
      showResult(providerResult, false, `保存失败: ${error.message}`);
    }
  });

  bindForm(routeForm, async () => {
    routeResult.hidden = true;
    const body = {
      model: document.getElementById("route-model").value.trim(),
      providerId: document.getElementById("route-provider-id").value.trim(),
      providerModel: document.getElementById("route-provider-model").value.trim()
    };

    try {
      const payload = await adminPost("/admin/v1/model-routes", body);
      showResult(
        routeResult,
        true,
        `模型已添加: ${payload.modelRoute.model} -> ${payload.modelRoute.providerId}/${payload.modelRoute.providerModel}`
      );
      routeForm.reset();
      await loadRoutes();
    } catch (error) {
      showResult(routeResult, false, `添加失败: ${error.message}`);
    }
  });

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

  return {
    refresh: async () => {
      await loadProviders();
      await loadRoutes();
    }
  };
}
