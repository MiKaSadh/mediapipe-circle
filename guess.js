const STORAGE_KEY_API_KEY = "guess_api_key";
const STORAGE_KEY_MODEL = "guess_model";
const DEFAULT_MODEL = "claude-opus-5-5";

const SYSTEM_PROMPT = `あなたは「うろ覚え探偵」です。SNSで話題になった「うろ覚えの書籍名を当てる司書」の仕組みを、書籍だけでなく映画・アニメ・ゲーム・音楽・人物・地名・企業名・商品名など、あらゆる固有名詞に広げたものです。

ユーザーは対象の名前を覚えていませんが、断片的な特徴（あらすじ、見た年代、印象的なシーン、色、感情、聞いた場所など）を持っています。あなたの仕事は、対話を通してその固有名詞を当てることです。

厳守するルール：
1. 一度の返信で聞く質問は1つだけ。的を絞った具体的な質問にする（ジャンル、年代、国、色、登場人物の特徴など、候補を大きく絞れる軸を優先する）。
2. まだ確信が持てない段階では、質問だけを返す。候補を無理に出さない。
3. ある程度絞り込めたら、候補を1〜3個、確信度（高い/中くらい/低い）付きで提示し、それぞれ「なぜそう思うか」を一言添える。候補を出した後も、外れていそうならさらに質問を続けてよい。
4. 十分な確信が持てたら「これですね！」と1つに絞って断定し、簡単な説明を添える。
5. 情報が矛盾していたり、これ以上絞れないと判断したら、素直に「わかりませんでした。他に覚えていることはありますか？」と伝える。
6. 前置きや謝辞などの余計な言葉は入れず、質問または候補提示だけを簡潔に返す。
7. ユーザーが日本語で話しかけたら日本語で、英語なら英語で応答する。
8. 存在しない作品や人物を作り出さない。確信がない候補は「確信度：低い」と明示する。`;

const chatEl = document.getElementById("chat");
const composerForm = document.getElementById("composerForm");
const userInput = document.getElementById("userInput");
const sendBtn = document.getElementById("sendBtn");
const resetBtn = document.getElementById("resetBtn");

const settingsToggle = document.getElementById("settingsToggle");
const settingsBody = document.getElementById("settingsBody");
const apiKeyInput = document.getElementById("apiKeyInput");
const modelSelect = document.getElementById("modelSelect");
const saveKeyBtn = document.getElementById("saveKeyBtn");
const clearKeyBtn = document.getElementById("clearKeyBtn");

let conversation = [];
let isSending = false;

function loadSettings() {
  const savedKey = localStorage.getItem(STORAGE_KEY_API_KEY);
  const savedModel = localStorage.getItem(STORAGE_KEY_MODEL);
  if (savedKey) apiKeyInput.value = savedKey;
  modelSelect.value = savedModel || DEFAULT_MODEL;
}

function getApiKey() {
  return localStorage.getItem(STORAGE_KEY_API_KEY) || "";
}

function getModel() {
  return localStorage.getItem(STORAGE_KEY_MODEL) || DEFAULT_MODEL;
}

settingsToggle.addEventListener("click", () => {
  const isHidden = settingsBody.hasAttribute("hidden");
  if (isHidden) {
    settingsBody.removeAttribute("hidden");
    settingsToggle.setAttribute("aria-expanded", "true");
  } else {
    settingsBody.setAttribute("hidden", "");
    settingsToggle.setAttribute("aria-expanded", "false");
  }
});

saveKeyBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    appendMessage("system", "APIキーが空です。");
    return;
  }
  localStorage.setItem(STORAGE_KEY_API_KEY, key);
  localStorage.setItem(STORAGE_KEY_MODEL, modelSelect.value);
  appendMessage("system", "APIキーを保存しました。");
  settingsBody.setAttribute("hidden", "");
  settingsToggle.setAttribute("aria-expanded", "false");
});

clearKeyBtn.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY_API_KEY);
  apiKeyInput.value = "";
  appendMessage("system", "APIキーを削除しました。");
});

modelSelect.addEventListener("change", () => {
  localStorage.setItem(STORAGE_KEY_MODEL, modelSelect.value);
});

function appendMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function resetConversation() {
  conversation = [];
  chatEl.innerHTML = "";
  appendMessage(
    "system",
    "うろ覚えの手がかりを教えてください。あいまいな情報だけで大丈夫です。"
  );
}

async function callClaude(apiKey, model, messages) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
      output_config: { effort: "low" },
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errJson = await response.json();
      detail = errJson?.error?.message || "";
    } catch (_) {
      // ignore parse failure
    }
    if (response.status === 401) {
      throw new Error("APIキーが無効です。設定を確認してください。");
    }
    if (response.status === 429) {
      throw new Error("レート制限に達しました。少し待って再試行してください。");
    }
    throw new Error(`APIエラー (${response.status}): ${detail || "不明なエラー"}`);
  }

  const data = await response.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return textBlock ? textBlock.text : "";
}

async function handleSend() {
  if (isSending) return;
  const text = userInput.value.trim();
  if (!text) return;

  const apiKey = getApiKey();
  if (!apiKey) {
    appendMessage("error", "先に「⚙ APIキー設定」からAnthropic APIキーを保存してください。");
    settingsBody.removeAttribute("hidden");
    settingsToggle.setAttribute("aria-expanded", "true");
    return;
  }

  appendMessage("user", text);
  conversation.push({ role: "user", content: text });
  userInput.value = "";

  isSending = true;
  sendBtn.disabled = true;
  const thinkingEl = appendMessage("thinking", "考え中…");

  try {
    const reply = await callClaude(apiKey, getModel(), conversation);
    thinkingEl.remove();
    if (reply) {
      appendMessage("ai", reply);
      conversation.push({ role: "assistant", content: reply });
    } else {
      appendMessage("error", "応答が空でした。もう一度試してください。");
    }
  } catch (err) {
    thinkingEl.remove();
    appendMessage("error", err.message || "通信エラーが発生しました。");
  } finally {
    isSending = false;
    sendBtn.disabled = false;
    userInput.focus();
  }
}

composerForm.addEventListener("submit", (e) => {
  e.preventDefault();
  handleSend();
});

userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

resetBtn.addEventListener("click", () => {
  resetConversation();
});

loadSettings();
resetConversation();
