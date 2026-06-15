(() => {
  const apiKeyInput = document.getElementById("api-key");
  const modelSelect = document.getElementById("model-select");
  const customModelField = document.getElementById("custom-model-field");
  const customModelInput = document.getElementById("custom-model");
  const streamToggle = document.getElementById("stream-toggle");
  const messagesEl = document.getElementById("messages");
  const composer = document.getElementById("composer");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send-btn");
  const clearBtn = document.getElementById("clear-chat");

  const CUSTOM_OPTION = "__custom__";
  const history = [];

  apiKeyInput.value = localStorage.getItem("tm.apiKey") || "";
  apiKeyInput.addEventListener("change", () => {
    localStorage.setItem("tm.apiKey", apiKeyInput.value.trim());
  });

  async function loadModels() {
    let models = [];
    try {
      const res = await fetch("/models");
      if (res.ok) {
        models = (await res.json()).models || [];
      }
    } catch {
      // 加载失败时保留手填入口
    }
    modelSelect.innerHTML = "";
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      modelSelect.appendChild(option);
    }
    const custom = document.createElement("option");
    custom.value = CUSTOM_OPTION;
    custom.textContent = "自定义...";
    modelSelect.appendChild(custom);

    const saved = localStorage.getItem("tm.model");
    if (saved && models.includes(saved)) {
      modelSelect.value = saved;
    }
    syncCustomField();
  }

  function syncCustomField() {
    customModelField.hidden = modelSelect.value !== CUSTOM_OPTION;
  }

  modelSelect.addEventListener("change", () => {
    syncCustomField();
    if (modelSelect.value !== CUSTOM_OPTION) {
      localStorage.setItem("tm.model", modelSelect.value);
    }
  });

  function currentModel() {
    if (modelSelect.value === CUSTOM_OPTION) {
      return customModelInput.value.trim();
    }
    return modelSelect.value;
  }

  function appendMessage(role, text) {
    messagesEl.querySelector(".chat-empty")?.remove();
    const el = document.createElement("div");
    el.className = `msg ${role}`;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function appendMeta(text) {
    const el = document.createElement("div");
    el.className = "msg-meta";
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function buildMeta(requestId, usage) {
    const parts = [];
    if (requestId) {
      parts.push(`requestId: ${requestId}`);
    }
    if (usage) {
      const total = usage.total_tokens ?? usage.totalTokens;
      if (total != null) {
        parts.push(`tokens: ${total}`);
      }
    }
    return parts.join("  |  ");
  }

  async function readErrorMessage(res) {
    try {
      const body = await res.json();
      return body.error || body.code || `HTTP ${res.status}`;
    } catch {
      return `HTTP ${res.status}`;
    }
  }

  function parseSseChunk(rawChunk, assistantEl, state) {
    for (const line of rawChunk.split("\n")) {
      if (!line.startsWith("data:")) {
        continue;
      }
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = payload.choices?.[0]?.delta?.content;
      if (delta) {
        state.text += delta;
        assistantEl.textContent = state.text;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      if (payload.usage) {
        state.usage = payload.usage;
      }
    }
  }

  async function sendStreaming(headers, body, assistantEl) {
    const res = await fetch("/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, stream: true })
    });
    const requestId = res.headers.get("x-request-id");
    if (!res.ok) {
      throw new Error(await readErrorMessage(res));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const state = { text: "", usage: null };
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let splitIndex;
      while ((splitIndex = buffer.indexOf("\n\n")) !== -1) {
        parseSseChunk(buffer.slice(0, splitIndex), assistantEl, state);
        buffer = buffer.slice(splitIndex + 2);
      }
    }
    if (buffer.trim()) {
      parseSseChunk(buffer, assistantEl, state);
    }
    return { text: state.text, requestId, usage: state.usage };
  }

  async function sendNonStreaming(headers, body, assistantEl) {
    const res = await fetch("/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, stream: false })
    });
    if (!res.ok) {
      throw new Error(await readErrorMessage(res));
    }
    const payload = await res.json();
    assistantEl.textContent = payload.output || "";
    return { text: payload.output || "", requestId: payload.requestId, usage: payload.usage };
  }

  async function handleSend() {
    const content = inputEl.value.trim();
    const model = currentModel();
    if (!content) {
      return;
    }
    if (!model) {
      appendMessage("error", "请先选择或填写模型名");
      return;
    }

    inputEl.value = "";
    sendBtn.disabled = true;
    appendMessage("user", content);
    history.push({ role: "user", content });

    const headers = { "Content-Type": "application/json" };
    const apiKey = apiKeyInput.value.trim();
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const body = { model, messages: [...history] };
    const assistantEl = appendMessage("assistant", "");

    try {
      const result = streamToggle.checked
        ? await sendStreaming(headers, body, assistantEl)
        : await sendNonStreaming(headers, body, assistantEl);
      history.push({ role: "assistant", content: result.text });
      const meta = buildMeta(result.requestId, result.usage);
      if (meta) {
        appendMeta(meta);
      }
    } catch (error) {
      history.pop();
      assistantEl.className = "msg error";
      assistantEl.textContent = `请求失败: ${error.message}`;
    } finally {
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleSend();
  });

  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  });

  clearBtn.addEventListener("click", () => {
    history.length = 0;
    messagesEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.innerHTML = "<strong>开始对话</strong>填好 API Key 与模型后，在下方输入消息";
    messagesEl.appendChild(empty);
  });

  void loadModels();
})();
