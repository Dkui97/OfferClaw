'use strict';

// WorkBuddy 本机登录态接入（只读当前系统用户的桌面端登录文件；凭据只在主进程内存中使用）。
// 依据 WORKBUDDY-INTEGRATION.md：不做 OAuth，直接读 *.info 取 accessToken；
// 对话接口强制 stream:true 并在本地聚合成标准 chat.completion；
// token / refreshToken 绝不下发渲染层，preload 只暴露受限 IPC。
//
// 非官方用法：客户端升级可能导致路径/字段/接口变化，手动 OpenAI 兼容 provider 必须保留作回退。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BACKEND = process.env.WB_BACKEND || 'https://copilot.tencent.com';
const REFRESH_MARGIN_MS = 60_000;
const TIMEOUT_MS = 90_000;
const MODELS_TIMEOUT_MS = 8_000;
const NON_CHAT_TAGS = new Set(['text-to-image', 'image-to-image', 'text-to-video', 'image-to-video']);
/** 仅在模型列表接口失败时展示的兜底 id；不据此断言模型一定可用 */
const FALLBACK_MODELS = ['auto', 'deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.2', 'kimi-k2.7'];

function wbError(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

function authDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  }
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(dataHome, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
}

function findAuthFile() {
  try {
    const dir = authDir();
    const file = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.info')).sort()[0];
    return file ? path.join(dir, file) : '';
  } catch {
    return '';
  }
}

function readSession() {
  const filePath = findAuthFile();
  if (!filePath) throw wbError('WORKBUDDY_NOT_LOGGED_IN', '请先安装并登录 WorkBuddy 桌面端');
  let session;
  try {
    session = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw wbError('WORKBUDDY_AUTH_INVALID', 'WorkBuddy 登录文件无法解析，请在桌面端重新登录');
  }
  const auth = session && session.auth;
  if (!auth || !auth.accessToken) throw wbError('WORKBUDDY_TOKEN_MISSING', '登录文件里没有访问令牌，请在桌面端重新登录');
  return { filePath, session, auth, account: (session && session.account) || {} };
}

function headers(auth, account, productName) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${auth.accessToken || ''}`,
    'X-User-Id': account.uid || '',
    'X-Enterprise-Id': account.enterpriseId || '',
    'X-Tenant-Id': account.enterpriseId || '',
    'X-Domain': auth.domain || 'www.codebuddy.cn',
    'User-Agent': `${productName}/1.0 (WorkBuddy Local)`,
  };
}

function describe(status, text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (status === 401) return 'WorkBuddy 登录已失效（401），请打开桌面端重新登录';
  if (status === 403) return `拒绝访问（403）：${raw}`;
  if (status === 429) return '请求过频或积分不足（429），请稍后再试';
  if (status === 400) return `请求参数或模型不可用（400）：${raw}`;
  return `接口返回 HTTP ${status} ${raw}`;
}

/** SSE 聚合：按 \n\n 分帧，处理跨 chunk 边界与 UTF-8 增量解码，只取 delta.content。 */
async function aggregate(res, fallbackModel) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let finishReason = null;
  let usage = null;
  let id = '';
  let created = 0;
  let model = fallbackModel;

  const handle = (block) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    if (!data || data === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(data); } catch { return; }
    const choice = chunk && chunk.choices && chunk.choices[0];
    id = id || chunk.id || '';
    created = created || chunk.created || 0;
    model = chunk.model || model;
    if (typeof (choice && choice.delta && choice.delta.content) === 'string') content += choice.delta.content;
    if (choice && choice.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  };

  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) throw wbError('WORKBUDDY_SSE_UNSUPPORTED', '上游响应不支持流式读取');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) !== -1) {
      handle(buffer.slice(0, i));
      buffer = buffer.slice(i + 2);
    }
  }
  if (buffer.trim()) handle(buffer);

  if (!content.trim()) throw wbError('WORKBUDDY_EMPTY_CONTENT', '模型没有返回内容（可能是模型不可用或积分不足）');
  return {
    id: id || `workbuddy-${Date.now()}`,
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model,
    usage: usage || null,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason || 'stop' }],
  };
}

function mapModels(models) {
  return models
    .filter((m) => m && typeof m.id === 'string' && m.id)
    .filter((m) => !(m.tags || []).some((tag) => NON_CHAT_TAGS.has(String(tag))))
    .map((m) => {
      const credits = String(m.credits || '');
      const matched = credits.match(/x\s*([0-9.]+)/i);
      return {
        id: m.id,
        name: m.name || m.id,
        credits: matched ? `x${matched[1]}` : credits,
        badges: (m.tags || [])
          .filter((tag) => String(tag).startsWith('badge:'))
          .map((tag) => {
            const parts = String(tag).split(':');
            return { text: parts[1] || '', color: parts[2] || '#22c55e' };
          })
          .filter((b) => b.text),
        description: m.descriptionZh || m.descriptionEn || '',
        context: Number(m.maxInputTokens || (m.contextWindow && m.contextWindow.defaultLength) || 0),
        default: Boolean(m.isDefault),
      };
    });
}

function createWorkBuddyClient({ fetchImpl, productName = 'BossClaw' } = {}) {
  const http = typeof fetchImpl === 'function' ? fetchImpl : (...args) => globalThis.fetch(...args);
  let modelsCache = { at: 0, list: [] };
  let refreshInFlight = null;

  async function refresh(loaded) {
    if (!loaded.auth.refreshToken) {
      throw wbError('WORKBUDDY_REFRESH_UNAVAILABLE', '登录已过期且无刷新令牌，请在桌面端重新登录');
    }
    // 单飞：避免并发调用同时刷新、互相顶掉 refreshToken
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const h = headers(loaded.auth, loaded.account, productName);
      h['X-Refresh-Token'] = loaded.auth.refreshToken;
      h['X-Auth-Refresh-Source'] = 'plugin';
      const res = await http(`${BACKEND}/v2/plugin/auth/token/refresh`, {
        method: 'POST',
        headers: h,
        body: '{}',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const payload = await res.json().catch(() => ({}));
      const data = payload && payload.data;
      if (!res.ok || Number(payload && payload.code) !== 0 || !data || !data.accessToken) {
        throw wbError(
          'WORKBUDDY_REFRESH_FAILED',
          `刷新登录态失败：${(payload && payload.msg) || `HTTP ${res.status}`}`,
          res.status,
        );
      }
      const nextAuth = {
        ...data,
        domain: data.domain || loaded.auth.domain,
        lastRefreshTime: Date.now(),
      };
      if (!nextAuth.expiresAt && nextAuth.expiresIn) {
        nextAuth.expiresAt = Date.now() + Number(nextAuth.expiresIn) * 1000;
      }
      try {
        const tmp = `${loaded.filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ ...loaded.session, auth: nextAuth }, null, 2), 'utf8');
        fs.renameSync(tmp, loaded.filePath);
      } catch {
        // 回写失败只影响下次刷新，不影响本次请求（桌面端也会自行刷新）
      }
      return { ...loaded, auth: nextAuth };
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  async function getSession() {
    const loaded = readSession();
    const expiresAt = Number(loaded.auth.expiresAt || 0);
    if (expiresAt && Date.now() >= expiresAt - REFRESH_MARGIN_MS) return refresh(loaded);
    return loaded;
  }

  /** 只返回非敏感状态给渲染层；nickname/uid 用于「已登录账号」展示。 */
  function status() {
    try {
      const loaded = readSession();
      const account = loaded.account || {};
      return {
        ok: true,
        loggedIn: true,
        nickname: account.nickname || '',
        uid: account.uid || '',
        expiresAt: Number(loaded.auth.expiresAt || 0) || undefined,
      };
    } catch (err) {
      return { ok: false, loggedIn: false, code: err.code, message: err.message };
    }
  }

  async function chat(messages, opts = {}) {
    const model = opts.model || 'auto';
    const effort = ['low', 'medium', 'high'].includes(opts.effort) ? opts.effort : 'medium';
    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || TIMEOUT_MS);
    // 连接自检不带 reasoning_effort，避免把「网关不认参」误判成「连不上」
    const useEffortByDefault = opts.test !== true;

    const send = async (useEffort) => {
      const loaded = await getSession();
      const body = {
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (useEffort && useEffortByDefault) body.reasoning_effort = effort;
      const res = await http(`${BACKEND}/v2/chat/completions`, {
        method: 'POST',
        headers: headers(loaded.auth, loaded.account, productName),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw wbError('WORKBUDDY_HTTP', describe(res.status, await res.text().catch(() => '')), res.status);
      // HTTP 200 但业务 code !== 0 时同样按失败处理（取 msg），避免误报连接成功。
      // 对话接口只返回 SSE；非 event-stream 响应直接解析为错误 JSON。
      const contentType = res.headers && res.headers.get ? String(res.headers.get('content-type') || '') : '';
      if (contentType && !/event-stream/i.test(contentType)) {
        const raw = await res.text().catch(() => '');
        let msg = String(raw).replace(/\s+/g, ' ').trim().slice(0, 160);
        try {
          const payload = JSON.parse(raw);
          if (payload && Number(payload.code) !== 0) msg = String(payload.msg || msg);
        } catch { /* 非 JSON 响应直接透出原文片段 */ }
        throw wbError('WORKBUDDY_API_ERROR', `WorkBuddy 接口返回异常：${msg}`);
      }
      return aggregate(res, model);
    };

    try {
      return await send(true);
    } catch (err) {
      const statusCode = Number(err && err.status) || 0;
      const is4xx = (statusCode >= 400 && statusCode < 500) || /4\d\d/.test(String((err && err.message) || err));
      if (!is4xx || !useEffortByDefault) throw err;
      // 老网关不认识 reasoning_effort：去掉该参数重试一次
      return send(false);
    }
  }

  async function listModels(opts = {}) {
    try {
      if (!opts.force && modelsCache.list.length && Date.now() - modelsCache.at < 300_000) {
        return { ok: true, models: modelsCache.list };
      }
      const loaded = await getSession();
      const res = await http(`${BACKEND}/v2/enterprises/personal/models`, {
        headers: headers(loaded.auth, loaded.account, productName),
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || Number(payload && payload.code) !== 0) {
        throw wbError(
          'WORKBUDDY_MODELS_FAILED',
          `获取模型列表失败：${(payload && payload.msg) || `HTTP ${res.status}`}`,
          res.status,
        );
      }
      const list = mapModels((payload.data && payload.data.models) || []);
      if (!list.length) throw wbError('WORKBUDDY_MODELS_EMPTY', '接口没有返回可用模型');
      modelsCache = { at: Date.now(), list };
      return { ok: true, models: list };
    } catch (err) {
      return {
        ok: false,
        code: err.code,
        error: err.message,
        fallbackModels: FALLBACK_MODELS,
      };
    }
  }

  return { status, chat, listModels };
}

module.exports = { createWorkBuddyClient, findAuthFile, authDir };
