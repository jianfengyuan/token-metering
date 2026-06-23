export function getTokenInput() {
  return document.getElementById("admin-token");
}

export function authHeaders() {
  const tokenInput = getTokenInput();
  const token = tokenInput?.value.trim() ?? "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function adminFetch(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.headers ?? {})
    }
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) {
    return null;
  }
  return res.json();
}

export async function adminPost(path, body) {
  return adminFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function formatTime(iso) {
  if (!iso) {
    return "-";
  }
  return iso.replace("T", " ").slice(0, 19);
}

export function renderEmpty(tbody, colspan, text) {
  tbody.innerHTML = `<tr><td colspan="${colspan}" class="empty-row">${text}</td></tr>`;
}

export function cell(text, mono = false) {
  const td = document.createElement("td");
  td.textContent = text ?? "-";
  if (mono) {
    td.className = "mono";
  }
  return td;
}

export function outcomeBadge(outcome) {
  const td = document.createElement("td");
  const span = document.createElement("span");
  span.className = `badge ${outcome}`;
  span.textContent = outcome;
  td.appendChild(span);
  return td;
}

export function showResult(el, success, message, keyValue) {
  el.hidden = false;
  el.className = `result-box ${success ? "success" : "error"}`;
  el.innerHTML = "";
  const head = document.createElement("div");
  head.textContent = message;
  el.append(head);
  if (keyValue) {
    const keyLine = document.createElement("div");
    keyLine.className = "key-line";
    keyLine.textContent = `API Key: ${keyValue}`;
    el.append(keyLine);
  }
}

export function bindForm(form, handler) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await handler();
    } catch (error) {
      console.error(error);
    }
  });
}

export function fillSelect(select, options, placeholder) {
  if (!select) {
    return;
  }
  select.innerHTML = "";
  const placeholderOption = document.createElement("option");
  placeholderOption.value = "";
  placeholderOption.textContent = placeholder;
  select.appendChild(placeholderOption);
  for (const option of options) {
    const item = document.createElement("option");
    item.value = option.value;
    item.textContent = option.label;
    select.appendChild(item);
  }
  select.disabled = options.length === 0;
}
