/**
 * =================================================================================
 * 项目: zimage-2api (Cloudflare Worker 单文件·全功能修复版)
 * 版本: 2.3.0 (代号: Turbo Cockpit - Ultimate)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-15
 *
 * [v2.3.0 优化日志]
 * 1. [性能优化] 添加请求重试机制，提高稳定性
 * 2. [功能增强] 支持 negative_prompt 负面提示词
 * 3. [功能增强] 添加 /v1/health 健康检查端点
 * 4. [代码质量] 添加请求速率限制 (基于内存)
 * 5. [代码质量] 添加结构化日志系统
 * 6. [UI/UX] 添加生成历史记录 (本地存储)
 * 7. [UI/UX] 添加图片下载功能
 * 8. [UI/UX] 添加键盘快捷键支持 (Ctrl+Enter 生成)
 * 9. [UI/UX] 优化移动端交互体验
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  PROJECT_NAME: "zimage-2api",
  PROJECT_VERSION: "2.3.0",

  // 安全配置 (API Key) - 建议在部署后修改
  API_MASTER_KEY: "1",

  // 上游服务配置
  UPSTREAM_URL: "https://z-image.62tool.com/api.php",
  ORIGIN_URL: "https://z-image.62tool.com",
  REFERER_URL: "https://z-image.62tool.com/",

  // 模型列表
  MODELS: ["z-image-turbo", "dall-e-3"],
  DEFAULT_MODEL: "z-image-turbo",

  // 默认参数
  DEFAULT_STEPS: 8,
  DEFAULT_SIZE: "1024x1024",

  // 轮询配置 (服务端模式)
  POLLING_INTERVAL: 1500,
  POLLING_TIMEOUT: 60000,
  STREAM_POLLING_INTERVAL: 1500,  // 流式模式轮询间隔
  NON_STREAM_POLLING_INTERVAL: 2000,  // 非流式模式轮询间隔

  // 重试配置
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,

  // 速率限制 (每分钟请求数)
  RATE_LIMIT: 30,
  RATE_LIMIT_WINDOW: 60000,

  // 伪装指纹池
  USER_AGENTS: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
  ]
};

// --- [速率限制器 (内存实现)] ---
const rateLimiter = {
  requests: new Map(),

  check(clientId) {
    const now = Date.now();
    const windowStart = now - CONFIG.RATE_LIMIT_WINDOW;

    // 清理过期记录
    if (!this.requests.has(clientId)) {
      this.requests.set(clientId, []);
    }

    const clientRequests = this.requests.get(clientId).filter(t => t > windowStart);
    this.requests.set(clientId, clientRequests);

    if (clientRequests.length >= CONFIG.RATE_LIMIT) {
      return false;
    }

    clientRequests.push(now);
    return true;
  },

  getRemaining(clientId) {
    const requests = this.requests.get(clientId) || [];
    const windowStart = Date.now() - CONFIG.RATE_LIMIT_WINDOW;
    const validRequests = requests.filter(t => t > windowStart);
    return Math.max(0, CONFIG.RATE_LIMIT - validRequests.length);
  }
};

// --- [结构化日志系统] ---
const Logger = {
  _format(level, message, data = {}) {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...data
    });
  },

  info(message, data) { console.log(this._format('INFO', message, data)); },
  warn(message, data) { console.warn(this._format('WARN', message, data)); },
  error(message, data) { console.error(this._format('ERROR', message, data)); }
};

// --- [第二部分: Worker 入口] ---
export default {
  /**
   * @param {Request} request
   * @param {Object} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    const url = new URL(request.url);
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 速率限制检查 (排除静态页面和健康检查)
    if (url.pathname.startsWith('/v1/') && url.pathname !== '/v1/health' && url.pathname !== '/v1/models') {
      if (!rateLimiter.check(clientIP)) {
        Logger.warn('Rate limit exceeded', { clientIP, path: url.pathname });
        return createErrorResponse('Rate limit exceeded. Please slow down.', 429, 'rate_limit_exceeded');
      }
    }

    // 路由分发
    if (url.pathname === '/') return handleUI(request, apiKey);
    if (url.pathname === '/v1/health') return handleHealthCheck();
    if (url.pathname === '/v1/models') return handleModelsRequest();
    if (url.pathname === '/v1/images/generations') return handleImageGenerations(request, apiKey);

    // 显式传递 ctx 给 handleChatCompletions
    if (url.pathname === '/v1/chat/completions') return handleChatCompletions(request, apiKey, ctx);

    // [WebUI 专用] 状态查询接口
    if (url.pathname === '/v1/query/status') return handleStatusQuery(request, apiKey);

    return createErrorResponse(`Path not found: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: 核心业务逻辑] ---

class IdentityForge {
  // 使用 crypto API 生成更高效的随机十六进制字符串
  static generateHex(length) {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
  }

  static getHeaders() {
    const ua = CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
    // 动态生成 Session 和 百度统计 ID
    const sessionCookie = this.generateHex(32);
    const hmAccount = this.generateHex(16).toUpperCase();
    const timestamp = Math.floor(Date.now() / 1000);
    
    const cookie = `server_name_session=${sessionCookie}; Hm_lvt_2348c268e6bf5008b52f68ddd772f997=${timestamp}; Hm_lpvt_2348c268e6bf5008b52f68ddd772f997=${timestamp}; HMACCOUNT=${hmAccount}`;

    return {
      "Authority": "z-image.62tool.com",
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Content-Type": "application/json",
      "Origin": CONFIG.ORIGIN_URL,
      "Referer": CONFIG.REFERER_URL,
      "User-Agent": ua,
      "Cookie": cookie
    };
  }

  static generateTaskId() {
    return `task_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  }
}

/**
 * 带重试的 fetch 请求
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} retries
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options, retries = CONFIG.MAX_RETRIES) {
    let lastError;
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, options);
            if (res.ok || res.status < 500) return res;
            throw new Error(`HTTP ${res.status}`);
        } catch (e) {
            lastError = e;
            if (i < retries) {
                Logger.warn('Request failed, retrying', { attempt: i + 1, error: e.message });
                await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY * (i + 1)));
            }
        }
    }
    throw lastError;
}

/**
 * 提交生成任务
 * @param {string} prompt - 正面提示词
 * @param {Object} params - 参数对象
 * @param {string} params.size - 图像尺寸
 * @param {number} params.steps - 生成步数
 * @param {number} params.seed - 随机种子
 * @param {string} params.negative_prompt - 负面提示词
 * @returns {Promise<Object>} { taskId, headers, success }
 */
async function submitTask(prompt, params = {}) {
    const headers = IdentityForge.getHeaders();
    const taskId = IdentityForge.generateTaskId();

    // 构建完整提示词 (如果有负面提示词)
    let fullPrompt = prompt;
    if (params.negative_prompt) {
        fullPrompt = `${prompt} --no ${params.negative_prompt}`;
    }

    const payload = {
        "action": "create",
        "task_id": taskId,
        "task_type": "text2img-z-image",
        "task_data": {
            "prompt": fullPrompt,
            "size": params.size || CONFIG.DEFAULT_SIZE,
            "seed": params.seed || Math.floor(Math.random() * 1000000),
            "steps": params.steps || CONFIG.DEFAULT_STEPS,
            "randomized": params.seed ? false : true
        },
        "status": 0
    };

    Logger.info('Submitting task', { taskId, prompt: prompt.slice(0, 50) });

    const res = await fetchWithRetry(CONFIG.UPSTREAM_URL, {
        method: "POST", headers: headers, body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`Create Failed: ${res.status}`);
    const data = await res.json();

    if (!data.success) throw new Error(`API Refused: ${data.message}`);

    Logger.info('Task submitted', { taskId });
    return { taskId, headers }; // 返回 headers 是因为查询时需要保持 Session 一致
}

/**
 * 查询任务状态
 */
async function queryTask(taskId, headers) {
    const payload = { "action": "query", "task_ids": [taskId] };
    const res = await fetch(CONFIG.UPSTREAM_URL, {
        method: "POST", headers: headers, body: JSON.stringify(payload)
    });

    if (!res.ok) return { status: 'retry' };
    const data = await res.json();

    if (data.success && data.data?.tasks?.length > 0) {
        const task = data.data.tasks[0];
        // status: 0=queue, 1=running, 2=success, -1=fail
        if (task.status === 2 && task.res_data?.image_url) {
            return { status: 'success', url: task.res_data.image_url.replace(/\\\//g, '/') };
        }
        if (task.status === -1) return { status: 'failed', error: 'Generation failed' };
        return { status: 'processing', progress: task.status === 1 ? 50 : 10 };
    }
    return { status: 'retry' };
}

/**
 * 通用轮询函数 - 等待任务完成
 * @param {string} taskId - 任务ID
 * @param {Object} headers - 请求头
 * @param {Object} options - 轮询选项
 * @param {number} options.timeout - 超时时间(ms)
 * @param {number} options.interval - 轮询间隔(ms)
 * @param {Function} options.onProgress - 进度回调
 * @returns {Promise<{url: string}>}
 */
async function pollForResult(taskId, headers, options = {}) {
    const timeout = options.timeout || CONFIG.POLLING_TIMEOUT;
    const interval = options.interval || CONFIG.POLLING_INTERVAL;
    const onProgress = options.onProgress || (() => {});

    const startTime = Date.now();
    let iteration = 0;

    while (Date.now() - startTime < timeout) {
        await new Promise(r => setTimeout(r, interval));
        const result = await queryTask(taskId, headers);
        iteration++;

        if (result.status === 'success') {
            return { url: result.url };
        }
        if (result.status === 'failed') {
            throw new Error(result.error || 'Generation failed');
        }

        // 调用进度回调
        onProgress({ iteration, elapsed: Date.now() - startTime });
    }

    throw new Error('Timeout: Image generation took too long');
}

// --- [API Handlers] ---

async function handleImageGenerations(request, apiKey) {
    if (!verifyAuth(request, apiKey)) return createErrorResponse('Unauthorized', 401, 'unauthorized');

    try {
        const body = await request.json();
        const prompt = body.prompt;

        if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
            return createErrorResponse('Missing or invalid prompt', 400, 'invalid_request');
        }

        // 提取自定义参数
        const size = body.size || CONFIG.DEFAULT_SIZE;
        const steps = body.steps || body.n_steps || CONFIG.DEFAULT_STEPS;
        const seed = body.seed ? parseInt(body.seed) : null;
        const negativePrompt = body.negative_prompt || null;
        const clientPoll = body.client_poll === true; // WebUI 专用标记

        // 1. 提交任务
        const { taskId, headers } = await submitTask(prompt, { size, steps, seed, negative_prompt: negativePrompt });

        // [Mode A] 客户端轮询 (WebUI)
        if (clientPoll) {
            const authContext = btoa(JSON.stringify(headers));
            return new Response(JSON.stringify({
                status: "submitted",
                task_id: taskId,
                auth_context: authContext
            }), { headers: corsHeaders({'Content-Type': 'application/json'}) });
        }

        // [Mode B] 服务端轮询 (Standard API Client)
        const result = await pollForResult(taskId, headers);
        Logger.info('Generation completed', { taskId });
        return new Response(JSON.stringify({
            created: Math.floor(Date.now() / 1000),
            data: [{ url: result.url }]
        }), { headers: corsHeaders({'Content-Type': 'application/json'}) });

    } catch (e) {
        Logger.error('Generation failed', { error: e.message });
        return createErrorResponse(e.message, 500, 'internal_error');
    }
}

// WebUI 专用的状态查询接口
async function handleStatusQuery(request, apiKey) {
    try {
        const body = await request.json();
        const { task_id, auth_context } = body;
        
        if (!task_id || !auth_context) throw new Error("Missing params");
        
        // 还原 Session Headers
        const headers = JSON.parse(atob(auth_context));
        const result = await queryTask(task_id, headers);
        
        return new Response(JSON.stringify(result), { headers: corsHeaders({'Content-Type': 'application/json'}) });
    } catch (e) {
        return createErrorResponse(e.message, 400, 'query_error');
    }
}

/**
 * 完美适配 Cherry Studio / NextChat 的聊天接口
 * 通过流式响应返回 Markdown 图片
 * @param {Request} request
 * @param {string} apiKey
 * @param {ExecutionContext} ctx
 */
async function handleChatCompletions(request, apiKey, ctx) {
    if (!verifyAuth(request, apiKey)) return createErrorResponse('Unauthorized', 401, 'unauthorized');

    const requestId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    try {
        const body = await request.json();
        const lastMsg = body.messages?.[body.messages.length - 1];
        if (!lastMsg?.content) {
            return createErrorResponse('No valid message content provided', 400, 'invalid_request');
        }

        const prompt = lastMsg.content;
        const model = body.model || CONFIG.DEFAULT_MODEL;
        const stream = body.stream !== false; // 默认为流式

        // 提交生成任务
        const { taskId, headers } = await submitTask(prompt, { size: CONFIG.DEFAULT_SIZE });

        // 如果客户端不支持流式，退回等待模式
        if (!stream) {
            const result = await pollForResult(taskId, headers, {
                interval: CONFIG.NON_STREAM_POLLING_INTERVAL
            });
            const content = `![Generated Image](${result.url})\n\n**Prompt:** ${prompt}`;
            return new Response(JSON.stringify({
                id: requestId,
                object: "chat.completion",
                created: created,
                model: model,
                choices: [{ index: 0, message: { role: "assistant", content: content }, finish_reason: "stop" }]
            }), { headers: corsHeaders({'Content-Type': 'application/json'}) });
        }

        // 开启流式响应 (SSE) - 专为 Cherry Studio 优化
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        const sendChunk = async (content, finish_reason = null) => {
            const chunk = {
                id: requestId,
                object: "chat.completion.chunk",
                created: created,
                model: model,
                choices: [{ index: 0, delta: { content: content }, finish_reason: finish_reason }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };

        // 在后台处理轮询，不阻塞主线程
        ctx.waitUntil((async () => {
            try {
                // 1. 发送初始状态
                await sendChunk("🎨 正在请求 Z-Image 引擎生成图片...\n\n> " + prompt + "\n\n");

                // 2. 使用通用轮询函数，带进度回调
                const result = await pollForResult(taskId, headers, {
                    interval: CONFIG.STREAM_POLLING_INTERVAL,
                    onProgress: async ({ iteration }) => {
                        // 每2次轮询发送一个进度点，保持连接活跃
                        if (iteration % 2 === 0) await sendChunk("·");
                    }
                });

                // 3. 发送最终图片 Markdown
                await sendChunk(`\n\n![Generated Image](${result.url})`);

                // 4. 发送结束信号
                await sendChunk("", "stop");
                await writer.write(encoder.encode("data: [DONE]\n\n"));

            } catch (error) {
                await sendChunk(`\n\n❌ **错误**: ${error.message}`, "stop");
                await writer.write(encoder.encode("data: [DONE]\n\n"));
            } finally {
                await writer.close();
            }
        })());

        return new Response(readable, {
            headers: corsHeaders({
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            })
        });

    } catch (e) {
        return createErrorResponse(e.message, 500, 'error');
    }
}

// --- 辅助函数 ---
function verifyAuth(req, key) {
    if (key === "1") return true;
    const h = req.headers.get('Authorization');
    return h && h === `Bearer ${key}`;
}
function corsHeaders(h={}) {
    return { ...h, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' };
}
function handleCorsPreflight() { return new Response(null, { status: 204, headers: corsHeaders() }); }
function createErrorResponse(msg, status, code) {
    return new Response(JSON.stringify({ error: { message: msg, code } }), { status, headers: corsHeaders({'Content-Type': 'application/json'}) });
}
function handleModelsRequest() {
    return new Response(JSON.stringify({ object: 'list', data: CONFIG.MODELS.map(id => ({ id, object: 'model', created: Date.now(), owned_by: 'zimage' })) }), { headers: corsHeaders({'Content-Type': 'application/json'}) });
}
function handleHealthCheck() {
    return new Response(JSON.stringify({
        status: 'healthy',
        version: CONFIG.PROJECT_VERSION,
        timestamp: new Date().toISOString()
    }), { headers: corsHeaders({'Content-Type': 'application/json'}) });
}


// --- [第四部分: 开发者驾驶舱 UI] ---
function handleUI(request, apiKey) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Z-Image Turbo API</title>
    <style>
        /* 暗色主题（默认） */
        :root, [data-theme="dark"] {
            --bg-primary: #0a0a0b;
            --bg-secondary: #131316;
            --bg-elevated: #1a1a1f;
            --bg-hover: #222228;
            --bg-active: #2a2a32;
            --text-primary: #f0f0f3;
            --text-secondary: #a0a0ab;
            --text-tertiary: #6b6b76;
            --border-subtle: rgba(255, 255, 255, 0.06);
            --border-default: rgba(255, 255, 255, 0.1);
            --border-strong: rgba(255, 255, 255, 0.15);
            --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
            --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.4);
            --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.5);
            --header-bg: rgba(10, 10, 11, 0.85);
            --color-scheme: dark;
        }

        /* 亮色主题 */
        [data-theme="light"] {
            --bg-primary: #f8fafc;
            --bg-secondary: #ffffff;
            --bg-elevated: #ffffff;
            --bg-hover: #f1f5f9;
            --bg-active: #e2e8f0;
            --text-primary: #0f172a;
            --text-secondary: #475569;
            --text-tertiary: #94a3b8;
            --border-subtle: rgba(0, 0, 0, 0.05);
            --border-default: rgba(0, 0, 0, 0.1);
            --border-strong: rgba(0, 0, 0, 0.15);
            --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
            --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
            --header-bg: rgba(248, 250, 252, 0.9);
            --color-scheme: light;
        }

        /* 共享变量 */
        :root {
            --accent-primary: #6366f1;
            --accent-hover: #4f46e5;
            --accent-glow: rgba(99, 102, 241, 0.3);
            --success: #10b981;
            --error: #ef4444;
            --space-1: 0.25rem;
            --space-2: 0.5rem;
            --space-3: 0.75rem;
            --space-4: 1rem;
            --space-5: 1.5rem;
            --space-6: 2rem;
            --radius-sm: 0.375rem;
            --radius-md: 0.5rem;
            --radius-lg: 0.75rem;
            --radius-xl: 1rem;
            --radius-full: 9999px;
            --transition-fast: 150ms ease;
            --transition-base: 250ms ease;
            --content-max-width: 720px;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        html {
            background: var(--bg-primary);
            color-scheme: var(--color-scheme);
            transition: background var(--transition-base);
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 1rem;
            line-height: 1.5;
            color: var(--text-primary);
            background: var(--bg-primary);
            min-height: 100vh;
            transition: background var(--transition-base), color var(--transition-base);
        }

        /* 滚动条 */
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: var(--radius-full); }

        /* 导航栏 */
        .header {
            position: sticky;
            top: 0;
            z-index: 50;
            background: var(--header-bg);
            backdrop-filter: blur(12px);
            border-bottom: 1px solid var(--border-subtle);
            padding: var(--space-3) var(--space-4);
            transition: background var(--transition-base);
        }

        .header-inner {
            max-width: var(--content-max-width);
            margin: 0 auto;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .logo-section {
            display: flex;
            align-items: center;
            gap: var(--space-2);
        }

        .logo-icon {
            width: 32px;
            height: 32px;
            background: linear-gradient(135deg, var(--accent-primary), var(--accent-hover));
            border-radius: var(--radius-md);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1rem;
            color: white;
            font-weight: 700;
        }

        .logo-title {
            font-size: 1.1rem;
            font-weight: 600;
            color: var(--text-primary);
        }

        .header-actions {
            display: flex;
            align-items: center;
            gap: var(--space-2);
        }

        /* 主题切换按钮 */
        .theme-toggle {
            width: 36px;
            height: 36px;
            border-radius: var(--radius-full);
            border: 1px solid var(--border-default);
            background: var(--bg-secondary);
            color: var(--text-secondary);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.1rem;
            transition: all var(--transition-fast);
        }

        .theme-toggle:hover {
            background: var(--bg-hover);
            border-color: var(--accent-primary);
            color: var(--accent-primary);
            transform: rotate(15deg);
        }

        .badge {
            padding: var(--space-1) var(--space-2);
            background: var(--bg-secondary);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-full);
            font-size: 0.7rem;
            color: var(--text-tertiary);
        }

        /* 主内容区 */
        .main-content {
            max-width: var(--content-max-width);
            margin: 0 auto;
            padding: var(--space-5) var(--space-4);
            display: flex;
            flex-direction: column;
            gap: var(--space-4);
        }

        /* 卡片 */
        .card {
            background: var(--bg-secondary);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-lg);
            padding: var(--space-4);
            transition: all var(--transition-base);
        }

        .card:hover {
            border-color: var(--border-default);
        }

        .card-header {
            display: flex;
            align-items: center;
            gap: var(--space-2);
            margin-bottom: var(--space-3);
        }

        .card-title {
            font-size: 0.9rem;
            font-weight: 600;
            color: var(--text-secondary);
            display: flex;
            align-items: center;
            gap: var(--space-2);
        }

        /* 预览区 */
        .preview-card {
            min-height: 380px;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            overflow: hidden;
        }

        .preview-image {
            max-width: 100%;
            max-height: 500px;
            border-radius: var(--radius-lg);
            box-shadow: var(--shadow-lg);
            animation: fadeInScale 0.5s ease-out;
            cursor: pointer;
            transition: transform var(--transition-base);
        }

        .preview-image:hover {
            transform: scale(1.02);
        }

        @keyframes fadeInScale {
            from { opacity: 0; transform: scale(0.95); }
            to { opacity: 1; transform: scale(1); }
        }

        .preview-placeholder {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: var(--space-4);
            color: var(--text-tertiary);
        }

        .placeholder-icon {
            width: 64px;
            height: 64px;
            background: var(--bg-hover);
            border: 2px dashed var(--border-default);
            border-radius: var(--radius-lg);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.5rem;
            opacity: 0.5;
        }

        .placeholder-text {
            font-size: 0.9rem;
            color: var(--text-tertiary);
        }

        /* 提示词输入框 */
        .prompt-card:focus-within {
            border-color: var(--accent-primary);
            box-shadow: 0 0 0 3px var(--accent-glow);
        }

        .prompt-textarea {
            width: 100%;
            min-height: 100px;
            padding: var(--space-4);
            background: var(--bg-secondary);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-lg);
            color: var(--text-primary);
            font-family: inherit;
            font-size: 1rem;
            line-height: 1.6;
            resize: vertical;
            transition: all var(--transition-fast);
        }

        .prompt-textarea:focus {
            outline: none;
            background: var(--bg-elevated);
            border-color: var(--accent-primary);
        }

        .prompt-textarea::placeholder {
            color: var(--text-tertiary);
        }

        /* 紧凑控件栏 */
        .compact-controls {
            display: flex;
            flex-wrap: wrap;
            gap: var(--space-2);
            align-items: center;
        }

        .compact-controls .custom-select {
            width: auto;
            min-width: 80px;
            padding: var(--space-2) var(--space-6) var(--space-2) var(--space-3);
            font-size: 0.875rem;
        }

        .steps-control {
            display: flex;
            align-items: center;
            gap: var(--space-2);
            flex: 1;
            min-width: 120px;
            max-width: 200px;
        }

        .steps-control .custom-slider {
            flex: 1;
        }

        .seed-control {
            display: flex;
            gap: var(--space-1);
        }

        .seed-control .custom-input {
            width: 80px;
            padding: var(--space-2) var(--space-2);
            font-size: 0.875rem;
            font-family: inherit;
        }

        .slider-value {
            min-width: 28px;
            padding: var(--space-1);
            background: var(--bg-hover);
            border-radius: var(--radius-sm);
            font-size: 0.75rem;
            font-weight: 600;
            color: var(--accent-primary);
            text-align: center;
        }

        /* 下拉选择器 */
        .custom-select {
            padding: var(--space-2) var(--space-6) var(--space-2) var(--space-3);
            background: var(--bg-secondary);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-md);
            color: var(--text-primary);
            font-size: 0.875rem;
            cursor: pointer;
            transition: all var(--transition-fast);
            appearance: none;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b6b76' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 8px center;
        }

        .custom-select:hover {
            border-color: var(--accent-primary);
        }

        .custom-select:focus {
            outline: none;
            border-color: var(--accent-primary);
        }

        /* 滑块 */
        .custom-slider {
            height: 4px;
            -webkit-appearance: none;
            appearance: none;
            background: var(--border-default);
            border-radius: var(--radius-full);
            outline: none;
            cursor: pointer;
        }

        .custom-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 14px;
            height: 14px;
            background: var(--accent-primary);
            border-radius: 50%;
            cursor: pointer;
            transition: transform var(--transition-fast);
        }

        .custom-slider::-webkit-slider-thumb:hover {
            transform: scale(1.2);
        }

        .custom-slider::-moz-range-thumb {
            width: 14px;
            height: 14px;
            background: var(--accent-primary);
            border: none;
            border-radius: 50%;
            cursor: pointer;
        }

        /* 输入框 */
        .custom-input {
            padding: var(--space-2) var(--space-3);
            background: var(--bg-secondary);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-md);
            color: var(--text-primary);
            font-size: 0.875rem;
            transition: all var(--transition-fast);
        }

        .custom-input:hover {
            border-color: var(--border-strong);
        }

        .custom-input:focus {
            outline: none;
            border-color: var(--accent-primary);
        }

        .custom-input::placeholder {
            color: var(--text-tertiary);
        }

        .dice-btn {
            padding: var(--space-2);
            background: var(--bg-secondary);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-md);
            cursor: pointer;
            transition: all var(--transition-fast);
            font-size: 0.875rem;
        }

        .dice-btn:hover {
            background: var(--bg-hover);
            border-color: var(--accent-primary);
        }

        /* 生成按钮 */
        .generate-button {
            padding: var(--space-2) var(--space-5);
            background: var(--accent-primary);
            border: none;
            border-radius: var(--radius-md);
            color: white;
            font-size: 0.875rem;
            font-weight: 600;
            cursor: pointer;
            transition: all var(--transition-fast);
            margin-left: auto;
        }

        .generate-button:hover {
            background: var(--accent-hover);
            transform: translateY(-1px);
        }

        .generate-button:active {
            transform: translateY(0);
        }

        .generate-button:disabled {
            background: var(--bg-hover);
            color: var(--text-tertiary);
            cursor: not-allowed;
            transform: none;
        }

        /* 文字按钮 */
        .text-btn {
            background: none;
            border: none;
            color: var(--text-tertiary);
            font-size: 0.8rem;
            cursor: pointer;
            transition: color var(--transition-fast);
        }

        .text-btn:hover {
            color: var(--accent-primary);
        }

        /* API 折叠 */
        .api-details {
            font-size: 0.8rem;
            color: var(--text-tertiary);
        }

        .api-summary {
            cursor: pointer;
            padding: var(--space-2);
            user-select: none;
            transition: color var(--transition-fast);
        }

        .api-summary:hover {
            color: var(--text-secondary);
        }

        .api-details .code-block {
            margin-top: var(--space-2);
            padding: var(--space-3);
            background: var(--bg-secondary);
            border-radius: var(--radius-md);
            font-family: monospace;
            font-size: 0.75rem;
            line-height: 1.8;
            white-space: pre-line;
            color: var(--text-secondary);
        }

        /* 加载动画 */
        .loading-spinner {
            width: 16px;
            height: 16px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-top-color: white;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            display: inline-block;
            margin-right: var(--space-2);
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        /* 进度条 */
        .progress-section {
            display: none;
        }

        .progress-section.visible {
            display: block;
        }

        .progress-container {
            width: 100%;
            background: var(--bg-secondary);
            border-radius: var(--radius-full);
            height: 4px;
            overflow: hidden;
        }

        .progress-text {
            margin-top: var(--space-2);
            font-size: 0.8rem;
            color: var(--text-secondary);
            text-align: center;
        }

        /* 响应式设计 */
        @media (max-width: 639px) {
            .main-content {
                padding: var(--space-4) var(--space-3);
            }

            .compact-controls {
                flex-direction: column;
                align-items: stretch;
            }

            .compact-controls .custom-select,
            .steps-control,
            .seed-control,
            .generate-button {
                width: 100%;
                max-width: none;
            }

            .generate-button {
                margin-left: 0;
            }

            .preview-card {
                min-height: 240px;
            }
        }

        /* 页面加载动画 */
        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        .fade-in-up {
            animation: fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            opacity: 0;
        }

        .stagger-1 { animation-delay: 0.1s; }
        .stagger-2 { animation-delay: 0.2s; }
        .stagger-3 { animation-delay: 0.3s; }
        .stagger-4 { animation-delay: 0.4s; }
        .stagger-5 { animation-delay: 0.5s; }

        /* Toast 通知 */
        .toast-container {
            position: fixed;
            bottom: var(--space-6);
            left: 50%;
            transform: translateX(-50%);
            z-index: 1000;
            display: flex;
            flex-direction: column;
            gap: var(--space-2);
            pointer-events: none;
        }

        .toast {
            padding: var(--space-3) var(--space-5);
            background: var(--bg-elevated);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-lg);
            color: var(--text-primary);
            font-size: 0.875rem;
            font-weight: 500;
            box-shadow: var(--shadow-lg);
            backdrop-filter: blur(12px);
            animation: toastIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            pointer-events: auto;
        }

        .toast.success {
            border-color: var(--success);
            background: rgba(16, 185, 129, 0.15);
        }

        .toast.error {
            border-color: var(--error);
            background: rgba(239, 68, 68, 0.15);
        }

        .toast.hiding {
            animation: toastOut 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }

        @keyframes toastIn {
            from {
                opacity: 0;
                transform: translateY(20px) scale(0.9);
            }
            to {
                opacity: 1;
                transform: translateY(0) scale(1);
            }
        }

        @keyframes toastOut {
            from {
                opacity: 1;
                transform: translateY(0) scale(1);
            }
            to {
                opacity: 0;
                transform: translateY(-10px) scale(0.9);
            }
        }

        /* 按钮涟漪效果 */
        .ripple-effect {
            position: relative;
            overflow: hidden;
        }

        .ripple {
            position: absolute;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.4);
            transform: scale(0);
            animation: ripple 0.6s ease-out;
            pointer-events: none;
        }

        @keyframes ripple {
            to {
                transform: scale(4);
                opacity: 0;
            }
        }

        /* 骨架屏动画 */
        .skeleton {
            background: linear-gradient(
                90deg,
                var(--bg-secondary) 0%,
                var(--bg-hover) 50%,
                var(--bg-secondary) 100%
            );
            background-size: 200% 100%;
            animation: skeleton-pulse 1.5s ease-in-out infinite;
            border-radius: var(--radius-lg);
        }

        @keyframes skeleton-pulse {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }

        .skeleton-preview {
            width: 100%;
            height: 300px;
            display: none;
        }

        /* 改进的图片出现动画 */
        @keyframes imageReveal {
            0% {
                opacity: 0;
                transform: scale(0.9);
                filter: blur(10px);
            }
            100% {
                opacity: 1;
                transform: scale(1);
                filter: blur(0);
            }
        }

        .preview-image.revealing {
            animation: imageReveal 0.7s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }

        /* 图片操作按钮改进 */
        .image-actions {
            position: absolute;
            bottom: var(--space-4);
            left: 50%;
            transform: translateX(-50%) translateY(20px);
            display: flex;
            gap: var(--space-2);
            background: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(12px);
            padding: var(--space-2) var(--space-3);
            border-radius: var(--radius-lg);
            opacity: 0;
            transition: all var(--transition-base);
        }

        .image-actions.visible {
            opacity: 1;
            transform: translateX(-50%) translateY(0);
        }

        /* 脉动效果 - 用于生成时 */
        @keyframes pulse-glow {
            0%, 100% {
                box-shadow: 0 0 20px var(--accent-glow);
            }
            50% {
                box-shadow: 0 0 40px var(--accent-glow), 0 0 60px rgba(99, 102, 241, 0.2);
            }
        }

        .generating .preview-card {
            animation: pulse-glow 2s ease-in-out infinite;
        }

        /* 悬浮微动效 */
        @keyframes float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-5px); }
        }

        .placeholder-icon {
            animation: float 3s ease-in-out infinite;
        }

        /* 改进进度条 */
        .progress-bar {
            height: 100%;
            background: linear-gradient(
                90deg,
                var(--accent-primary),
                var(--accent-hover),
                #818cf8,
                var(--accent-hover),
                var(--accent-primary)
            );
            background-size: 300% 100%;
            border-radius: var(--radius-full);
            transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
            animation: progress-shimmer 2s linear infinite;
            box-shadow: 0 0 15px var(--accent-glow), inset 0 1px 0 rgba(255,255,255,0.2);
        }

        @keyframes progress-shimmer {
            0% { background-position: 100% 0; }
            100% { background-position: -100% 0; }
        }

        /* 背景渐变动画 */
        .main-content::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background:
                radial-gradient(circle at 20% 20%, rgba(99, 102, 241, 0.08) 0%, transparent 50%),
                radial-gradient(circle at 80% 80%, rgba(139, 92, 246, 0.08) 0%, transparent 50%);
            pointer-events: none;
            z-index: -1;
            animation: bgShift 20s ease-in-out infinite alternate;
        }

        @keyframes bgShift {
            0% {
                opacity: 0.5;
            }
            100% {
                opacity: 1;
            }
        }

        /* 输入框聚焦动画 */
        .prompt-textarea, .custom-input, .custom-select {
            transition: all var(--transition-base), box-shadow 0.3s ease;
        }

        /* 历史记录项改进动画 */
        .history-item {
            aspect-ratio: 1;
            border-radius: var(--radius-md);
            overflow: hidden;
            cursor: pointer;
            border: 2px solid transparent;
            transition: all var(--transition-base);
            transform-origin: center;
        }

        .history-item:hover {
            border-color: var(--accent-primary);
            transform: scale(1.08);
            box-shadow: 0 4px 20px rgba(99, 102, 241, 0.3);
        }

        .history-item:active {
            transform: scale(0.98);
        }

        /* 减弱动画（用户偏好） */
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after {
                animation-duration: 0.01ms !important;
                transition-duration: 0.01ms !important;
            }
        }

        .action-btn {
            padding: var(--space-2) var(--space-3);
            background: var(--bg-elevated);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-md);
            color: var(--text-primary);
            font-size: 0.8125rem;
            cursor: pointer;
            transition: all var(--transition-fast);
        }

        .action-btn:hover {
            background: var(--accent-primary);
            border-color: var(--accent-primary);
            transform: translateY(-1px);
        }

        .action-btn:active {
            transform: translateY(0) scale(0.98);
        }

        /* 历史记录网格 */
        .history-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
            gap: var(--space-3);
            margin-top: var(--space-3);
        }

        .history-item img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        /* 负面提示词部分 */
        .negative-prompt-section {
            margin-top: var(--space-2);
        }
    </style>
</head>
<body>

<!-- Toast 通知容器 -->
<div class="toast-container" id="toastContainer"></div>

<!-- 顶部导航栏 -->
<header class="header fade-in-up">
    <div class="header-inner">
        <div class="logo-section">
            <div class="logo-icon">Z</div>
            <h1 class="logo-title">Z-Image</h1>
        </div>
        <div class="header-actions">
            <span class="badge">v2.3</span>
            <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="切换主题">
                <span id="themeIcon">🌙</span>
            </button>
        </div>
    </div>
</header>

<!-- 主内容区 -->
<main class="main-content" id="mainContent">
    <!-- 图像预览区 -->
    <div class="card preview-card fade-in-up stagger-1">
        <div class="skeleton skeleton-preview" id="skeletonPreview"></div>
        <div class="preview-placeholder" id="placeholder">
            <div class="placeholder-icon">🎨</div>
            <p class="placeholder-text">输入提示词开始创作</p>
        </div>
        <img id="resultImg" class="preview-image" style="display:none" onclick="window.open(this.src)">
        <div class="image-actions" id="imageActions">
            <button class="action-btn" onclick="downloadImage()">下载</button>
            <button class="action-btn" onclick="copyImageUrl()">复制链接</button>
        </div>
    </div>

    <!-- 提示词输入 -->
    <div class="card fade-in-up stagger-2">
        <textarea
            id="prompt"
            class="prompt-textarea"
            placeholder="描述你想生成的图像..."
        >A cute cat in cyberpunk city, neon lights, 8k quality</textarea>
        <input
            type="text"
            id="negativePrompt"
            class="custom-input"
            style="margin-top: var(--space-3);"
            placeholder="负面提示词（可选）"
        >
    </div>

    <!-- 参数 + 生成按钮 -->
    <div class="compact-controls fade-in-up stagger-3">
        <select id="sizeSelect" class="custom-select">
            <option value="1024x1024">1:1</option>
            <option value="1152x896">横向</option>
            <option value="896x1152">竖向</option>
            <option value="1344x768">宽屏</option>
            <option value="768x1344">竖屏</option>
        </select>
        <div class="steps-control">
            <input type="range" id="steps" class="custom-slider" min="1" max="20" value="8"
                   oninput="document.getElementById('stepsVal').innerText=this.value">
            <span class="slider-value" id="stepsVal">8</span>
        </div>
        <div class="seed-control">
            <input type="number" id="seed" class="custom-input" placeholder="种子">
            <button class="dice-btn" onclick="randomSeed()">🎲</button>
        </div>
        <button id="genBtn" class="generate-button" onclick="startGeneration()">
            <span class="button-content" id="btnContent">生成</span>
        </button>
    </div>

    <!-- 进度条 -->
    <div class="progress-section" id="progressSection">
        <div class="progress-container">
            <div class="progress-bar" id="progressBar" style="width: 0%"></div>
        </div>
        <p class="progress-text" id="statusText">准备中...</p>
    </div>

    <!-- 生成历史 -->
    <div class="card history-card fade-in-up" id="historyCard" style="display:none">
        <div class="card-header" style="justify-content:space-between;">
            <span class="card-title">历史记录</span>
            <button class="text-btn" onclick="clearHistory()">清空</button>
        </div>
        <div class="history-grid" id="historyGrid"></div>
    </div>

    <!-- API 信息（折叠） -->
    <details class="api-details fade-in-up">
        <summary class="api-summary">API 端点</summary>
        <div class="code-block">
${origin}/v1/images/generations
${origin}/v1/chat/completions
${origin}/v1/models</div>
    </details>

    <input type="hidden" id="apiKey" value="${apiKey}">
</main>

<script>
    // --- 主题切换 ---
    function toggleTheme() {
        const html = document.documentElement;
        const icon = document.getElementById('themeIcon');
        const current = html.getAttribute('data-theme') || 'dark';
        const next = current === 'dark' ? 'light' : 'dark';

        html.setAttribute('data-theme', next);
        icon.textContent = next === 'dark' ? '🌙' : '☀️';
        localStorage.setItem('theme', next);
    }

    // 初始化主题
    (function initTheme() {
        const saved = localStorage.getItem('theme');
        const prefer = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        const theme = saved || prefer;

        document.documentElement.setAttribute('data-theme', theme);
        const icon = document.getElementById('themeIcon');
        if (icon) icon.textContent = theme === 'dark' ? '🌙' : '☀️';
    })();

    // --- Toast 通知系统 ---
    function showToast(message, type = 'default', duration = 3000) {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = 'toast ' + type;
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('hiding');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // --- 历史记录管理 ---
    const HISTORY_KEY = 'zimage_history';
    const MAX_HISTORY = 20;

    function getHistory() {
        try {
            return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        } catch { return []; }
    }

    function saveToHistory(url, prompt) {
        const history = getHistory();
        history.unshift({ url, prompt, timestamp: Date.now() });
        if (history.length > MAX_HISTORY) history.pop();
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        renderHistory();
    }

    function renderHistory() {
        const history = getHistory();
        const card = document.getElementById('historyCard');
        const grid = document.getElementById('historyGrid');

        if (history.length === 0) {
            card.style.display = 'none';
            return;
        }

        card.style.display = 'block';
        grid.innerHTML = history.map((item, i) =>
            '<div class="history-item" onclick="loadFromHistory(' + i + ')" title="' + (item.prompt || '').slice(0, 50) + '">' +
            '<img src="' + item.url + '" loading="lazy" alt="历史图片">' +
            '</div>'
        ).join('');
    }

    function loadFromHistory(index) {
        const history = getHistory();
        if (history[index]) {
            const img = document.getElementById('resultImg');
            const ph = document.getElementById('placeholder');
            const actions = document.getElementById('imageActions');

            img.src = history[index].url;
            img.classList.add('revealing');
            img.style.display = 'block';
            ph.style.display = 'none';
            actions.classList.add('visible');

            // 移除动画类以便下次使用
            setTimeout(() => img.classList.remove('revealing'), 700);

            if (history[index].prompt) {
                document.getElementById('prompt').value = history[index].prompt;
            }
            showToast('已加载历史图片', 'success');
        }
    }

    function clearHistory() {
        if (confirm('确定要清空所有历史记录吗？')) {
            localStorage.removeItem(HISTORY_KEY);
            renderHistory();
            showToast('历史记录已清空', 'success');
        }
    }

    // --- 图片操作 ---
    function downloadImage() {
        const img = document.getElementById('resultImg');
        if (!img.src) return;

        const link = document.createElement('a');
        link.href = img.src;
        link.download = 'zimage_' + Date.now() + '.png';
        link.target = '_blank';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast('图片下载已开始', 'success');
    }

    function copyImageUrl() {
        const img = document.getElementById('resultImg');
        if (!img.src) return;

        navigator.clipboard.writeText(img.src).then(() => {
            showToast('链接已复制到剪贴板', 'success');
        });
    }

    // --- 基础功能 ---
    function randomSeed() {
        const seedInput = document.getElementById('seed');
        seedInput.value = Math.floor(Math.random() * 1000000);
        // 添加动画效果
        seedInput.style.transform = 'scale(1.05)';
        setTimeout(() => seedInput.style.transform = 'scale(1)', 150);
    }

    function copyEndpoint() {
        const text = '${origin}/v1/images/generations';
        navigator.clipboard.writeText(text).then(() => {
            showToast('API 端点已复制', 'success');
        });
    }

    async function startGeneration() {
        const prompt = document.getElementById('prompt').value.trim();
        if(!prompt) {
            showToast('请输入提示词', 'error');
            document.getElementById('prompt').focus();
            return;
        }

        const negativePrompt = document.getElementById('negativePrompt')?.value.trim() || '';
        const seed = document.getElementById('seed').value;
        const steps = document.getElementById('steps').value;
        const size = document.getElementById('sizeSelect').value;
        const btn = document.getElementById('genBtn');
        const btnContent = document.getElementById('btnContent');
        const progressSection = document.getElementById('progressSection');
        const pBar = document.getElementById('progressBar');
        const sText = document.getElementById('statusText');
        const img = document.getElementById('resultImg');
        const ph = document.getElementById('placeholder');
        const actions = document.getElementById('imageActions');
        const skeleton = document.getElementById('skeletonPreview');
        const mainContent = document.getElementById('mainContent');

        // Reset UI with animations
        btn.disabled = true;
        btnContent.innerHTML = '<div class="loading-spinner"></div>生成中';
        progressSection.classList.add('visible');
        pBar.style.width = '5%';
        sText.innerText = '正在初始化...';
        sText.style.color = 'var(--text-secondary)';
        img.style.display = 'none';
        img.classList.remove('revealing');
        actions.classList.remove('visible');
        skeleton.style.display = 'block';
        ph.style.display = 'none';
        mainContent.classList.add('generating');

        try {
            // 1. 提交任务
            const requestBody = {
                prompt,
                size: size,
                steps: parseInt(steps),
                seed: seed ? parseInt(seed) : null,
                client_poll: true
            };
            if (negativePrompt) requestBody.negative_prompt = negativePrompt;

            const res = await fetch('/v1/images/generations', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + document.getElementById('apiKey').value
                },
                body: JSON.stringify(requestBody)
            });

            if(!res.ok) throw new Error(await res.text());
            const initData = await res.json();

            if(initData.status !== 'submitted') throw new Error("任务提交失败");

            const taskId = initData.task_id;
            const authContext = initData.auth_context;

            // 2. 客户端轮询
            let progress = 10;
            const pollInterval = setInterval(async () => {
                try {
                    if(progress < 90) progress += (Math.random() * 5);
                    pBar.style.width = progress + '%';
                    sText.innerText = '生成中... ' + Math.floor(progress) + '%';

                    const qRes = await fetch('/v1/query/status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ task_id: taskId, auth_context: authContext })
                    });

                    const qData = await qRes.json();

                    if(qData.status === 'success') {
                        clearInterval(pollInterval);
                        pBar.style.width = '100%';
                        sText.innerText = '✅ 生成完成！点击图片查看大图';
                        sText.style.color = 'var(--success)';

                        // 隐藏骨架屏，显示图片
                        skeleton.style.display = 'none';
                        img.src = qData.url;
                        img.classList.add('revealing');
                        img.style.display = 'block';

                        // 延迟显示操作按钮
                        setTimeout(() => actions.classList.add('visible'), 400);

                        mainContent.classList.remove('generating');
                        saveToHistory(qData.url, prompt);
                        resetButton();
                        showToast('图片生成成功！', 'success');

                        // 移除动画类
                        setTimeout(() => img.classList.remove('revealing'), 700);
                    } else if(qData.status === 'failed') {
                        throw new Error(qData.error || 'Unknown Error');
                    }
                } catch(e) {
                    clearInterval(pollInterval);
                    sText.innerText = '❌ ' + e.message;
                    sText.style.color = 'var(--error)';
                    skeleton.style.display = 'none';
                    ph.style.display = 'flex';
                    ph.querySelector('.placeholder-text').innerText = e.message;
                    mainContent.classList.remove('generating');
                    resetButton();
                    showToast('生成失败: ' + e.message, 'error');
                }
            }, 1500);

        } catch(e) {
            sText.innerText = '❌ 请求失败: ' + e.message;
            sText.style.color = 'var(--error)';
            skeleton.style.display = 'none';
            ph.style.display = 'flex';
            ph.querySelector('.placeholder-text').innerText = e.message;
            mainContent.classList.remove('generating');
            resetButton();
            showToast('请求失败: ' + e.message, 'error');
        }
    }

    function resetButton() {
        const btn = document.getElementById('genBtn');
        const btnContent = document.getElementById('btnContent');
        btn.disabled = false;
        btnContent.innerHTML = '生成';
    }

    // --- 键盘快捷键 ---
    document.addEventListener('keydown', function(e) {
        // Ctrl+Enter 或 Cmd+Enter 生成图片
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            if (!document.getElementById('genBtn').disabled) {
                startGeneration();
            }
        }
    });

    // --- 页面加载时渲染历史 ---
    document.addEventListener('DOMContentLoaded', renderHistory);
</script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
