import { getTokenInput } from "./utils.js";
import { initTenantsTab } from "./tenants.js";
import { initPlatformTab } from "./platform.js";
import { initUsersTab } from "./users.js";
import { initMonitoringTab } from "./monitoring.js";

const tabs = {
  tenants: initTenantsTab(),
  platform: initPlatformTab(),
  users: initUsersTab(),
  monitoring: initMonitoringTab()
};

let activeTab = "tenants";

function switchTab(name) {
  activeTab = name;
  for (const button of document.querySelectorAll("#admin-tabs button")) {
    button.classList.toggle("active", button.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    panel.classList.toggle("active", panel.id === `tab-${name}`);
  }
  void tabs[name]?.refresh?.();
}

const tokenInput = getTokenInput();
tokenInput.value = localStorage.getItem("tm.adminToken") || "";
tokenInput.addEventListener("change", () => {
  localStorage.setItem("tm.adminToken", tokenInput.value.trim());
  void tabs[activeTab]?.refresh?.();
});

for (const button of document.querySelectorAll("#admin-tabs button")) {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
}

document.getElementById("refresh-all").addEventListener("click", () => {
  void tabs[activeTab]?.refresh?.();
});

switchTab("tenants");
