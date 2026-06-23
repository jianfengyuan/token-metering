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

async function loadTenantOptions(preferredTenantId) {
  const memberSelect = document.getElementById("member-tenant-id");
  const membersFilterSelect = document.getElementById("members-tenant-id");
  const previousTenantId = preferredTenantId ?? membersFilterSelect?.value ?? "";

  try {
    const data = await adminFetch("/admin/v1/tenants");
    const tenants = data.tenants || [];
    const options = tenants.map((tenant) => ({
      value: tenant.id,
      label: tenant.name ? `${tenant.name} (${tenant.id})` : tenant.id
    }));
    const placeholder = tenants.length === 0 ? "暂无租户，请先开通" : "请选择租户";

    fillSelect(memberSelect, options, placeholder);
    fillSelect(membersFilterSelect, options, placeholder);

    if (previousTenantId && options.some((option) => option.value === previousTenantId)) {
      memberSelect.value = previousTenantId;
      membersFilterSelect.value = previousTenantId;
    }
  } catch (error) {
    fillSelect(memberSelect, [], `加载失败: ${error.message}`);
    fillSelect(membersFilterSelect, [], `加载失败: ${error.message}`);
  }
}

export function initUsersTab() {
  const userForm = document.getElementById("user-form");
  const userResult = document.getElementById("user-result");
  const memberForm = document.getElementById("member-form");
  const memberResult = document.getElementById("member-result");
  const membersTenantInput = document.getElementById("members-tenant-id");

  bindForm(userForm, async () => {
    userResult.hidden = true;
    const body = {
      email: document.getElementById("user-email").value.trim(),
      name: document.getElementById("user-name").value.trim()
    };
    const platformRole = document.getElementById("user-platform-role").value;
    if (platformRole) {
      body.platformRole = platformRole;
    }

    try {
      const payload = await adminPost("/admin/v1/users", body);
      showResult(userResult, true, `用户已创建: ${payload.user.id} (${payload.user.email})`);
      userForm.reset();
      await loadUsers();
    } catch (error) {
      showResult(userResult, false, `创建失败: ${error.message}`);
    }
  });

  bindForm(memberForm, async () => {
    memberResult.hidden = true;
    const tenantId = document.getElementById("member-tenant-id").value.trim();
    if (!tenantId) {
      showResult(memberResult, false, "请先选择租户");
      return;
    }
    const body = {
      userId: document.getElementById("member-user-id").value.trim(),
      role: document.getElementById("member-role").value
    };

    try {
      const payload = await adminPost(`/admin/v1/tenants/${encodeURIComponent(tenantId)}/members`, body);
      showResult(memberResult, true, `成员已添加: ${payload.member.userId} -> ${payload.member.role}`);
      membersTenantInput.value = tenantId;
      await loadMembers(tenantId);
    } catch (error) {
      showResult(memberResult, false, `添加失败: ${error.message}`);
    }
  });

  membersTenantInput.addEventListener("change", () => {
    const tenantId = membersTenantInput.value.trim();
    if (tenantId) {
      document.getElementById("member-tenant-id").value = tenantId;
      void loadMembers(tenantId);
    } else {
      renderEmpty(document.getElementById("members-body"), 5, "请选择租户");
    }
  });

  return {
    refresh: refreshUsersTab
  };
}

async function refreshUsersTab(preferredTenantId) {
  await loadUsers();
  await loadTenantOptions(preferredTenantId);
  const tenantId = preferredTenantId ?? document.getElementById("members-tenant-id")?.value.trim();
  if (tenantId) {
    await loadMembers(tenantId);
  } else {
    renderEmpty(document.getElementById("members-body"), 5, "请选择租户");
  }
}

async function loadUsers() {
  const tbody = document.getElementById("users-body");
  try {
    const data = await adminFetch("/admin/v1/users");
    const users = data.users || [];
    if (users.length === 0) {
      renderEmpty(tbody, 5, "暂无用户");
      return;
    }
    tbody.innerHTML = "";
    for (const user of users) {
      const tr = document.createElement("tr");
      tr.appendChild(cell(user.id, true));
      tr.appendChild(cell(user.email));
      tr.appendChild(cell(user.name));
      tr.appendChild(cell(user.platformRole ?? "-"));
      tr.appendChild(cell(user.status));
      tbody.appendChild(tr);
    }
  } catch (error) {
    renderEmpty(tbody, 5, `加载失败: ${error.message}`);
  }
}

async function loadMembers(tenantId) {
  const tbody = document.getElementById("members-body");
  try {
    const data = await adminFetch(`/admin/v1/tenants/${encodeURIComponent(tenantId)}/members`);
    const members = data.members || [];
    if (members.length === 0) {
      renderEmpty(tbody, 5, "暂无成员");
      return;
    }
    tbody.innerHTML = "";
    for (const member of members) {
      const tr = document.createElement("tr");
      tr.appendChild(cell(member.userId, true));
      tr.appendChild(cell(member.email));
      tr.appendChild(cell(member.name));
      tr.appendChild(cell(member.role));
      tr.appendChild(cell(formatTime(member.joinedAt), true));
      tbody.appendChild(tr);
    }
  } catch (error) {
    renderEmpty(tbody, 5, `加载失败: ${error.message}`);
  }
}
