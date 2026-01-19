/**
 * Cloudflare Worker：为 right.codes 的 Responses 代理接口注入“粘性会话（sticky session）”
 * 路由头（routing headers）以及 `prompt_cache_key`。
 *
 * 作用场景：
 * - 目标上游：right.codes 上的 `/codex/v1/responses`（以及兼容 `/v1/responses`）
 * - 当后端是多实例/多机房时，通过同一个 `session_id` 让同一会话尽量落到同一条链路
 * - 同时把 `prompt_cache_key` 设为同一值，方便上游做提示词缓存命中
 *
 * sessionId 的来源（按优先级，从高到低）：
 * 1) 请求头：`x-session-id` / `conversation_id` / `session_id`
 * 2) Query 参数：`session_id`
 * 3) Cookie：`rc_session`
 * 4) 随机 UUID（仅当客户端后续携带 Cookie 时才会“稳定”）
 */

// 上游域名：统一转发到该 Host，避免 www 等变体导致的缓存/路由分裂。
const ORIGIN_HOST = "right.codes";

// 用于在浏览器侧持久化 sessionId 的 Cookie 名称。
const COOKIE_NAME = "rc_session";
function truncateForLog(text, maxChars = 20000) {
  if (typeof text !== "string") return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n...（已截断，原长度=${text.length}）`;
}

function printRequestBodiesLog(ctx, originalText, processedText, originalObj, processedObj) {
  const payload = {
    时间: new Date().toISOString(),
    请求ID: ctx.requestId,
    路径: ctx.path,
    方法: ctx.method,
    会话ID: ctx.sessionId || "",
    原始请求体: truncateForLog(originalText),
    处理后请求体: truncateForLog(processedText),
    处理前请求体对象: originalObj ?? null,
    处理后请求体对象: processedObj ?? null,
  };
  console.log(JSON.stringify(payload));
}

export default {
  /**
   * Worker 入口：仅对目标 Responses 接口做“会话粘性 + prompt_cache_key”注入，其余请求原样转发。
   *
   * @param {Request} request 传入的 HTTP 请求对象（由 Cloudflare Workers 运行时提供）。
   * @returns {Promise<Response>} 返回给客户端的响应（可能是预检响应、上游响应的透传等）。
   */
  async fetch(request) {
    const url = new URL(request.url);
    const ctx = {
      t0: Date.now(),
      requestId: crypto.randomUUID(),
      sessionId: "",
      method: request.method,
      path: url.pathname,
    };

    // 可选：处理 CORS 预检请求（浏览器会先发 OPTIONS）。
    // 注意：这里只做快速返回，不转发到上游。
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // 只处理我们关心的接口：POST /codex/v1/responses（以及 /v1/responses 兼容路径）。
    // 其他请求直接走默认 fetch，不做任何改写。
    const shouldRewrite =
      request.method === "POST" &&
      (url.pathname === "/codex/v1/responses" || url.pathname === "/v1/responses");

    if (!shouldRewrite) {
      return fetch(request);
    }

    // 计算/提取本次请求的会话标识，用于：
    // 1) 粘性路由（sticky routing）
    // 2) prompt cache key（提示词缓存键）
    // 为本次请求解析一个稳定的 sessionId（请求头/Query/Cookie/UUID）。
    const sid = await getSessionId(request, url);
    // `routeSid` 是实际注入的路由键；可能会被从 body 派生出来的 id 覆盖。
    let routeSid = sid;
    // 记录调用方是否显式提供了 sessionId；若已提供，则不要从 body 覆盖。
    const explicitSid =
      firstNonEmpty(
        request.headers.get("x-session-id"),
        request.headers.get("conversation_id"),
        request.headers.get("session_id")
      ) || firstNonEmpty(url.searchParams.get("session_id"));

    // 将路由用的 sessionId 写入结构化日志，便于追踪。
    ctx.sessionId = routeSid;

    // 注入粘性路由头：同时写入多个常见字段，方便上游或中间层识别。
    const headers = new Headers(request.headers);
    headers.set("x-session-id", routeSid);
    headers.set("conversation_id", routeSid);
    headers.set("session_id", routeSid);

    // 确保 JSON body 中存在 `prompt_cache_key`：
    // - 如果客户端没传，我们自动补上
    // - 仅在 content-type 为 application/json 时尝试解析
    /** @type {BodyInit | null} */
    let body = request.body;
    // 若请求显式携带 prompt_cache_key，则用于覆写响应中的同名字段。
    let requestHadPromptCacheKey = false;
    let requestPromptCacheKey = firstNonEmpty(
      headers.get("x-prompt-cache-key"),
      headers.get("prompt_cache_key"),
      url.searchParams.get("prompt_cache_key")
    );
    if (requestPromptCacheKey) requestHadPromptCacheKey = true;
    const contentType = headers.get("content-type") || "";
    // 为了输出“处理前/处理后”的请求体日志，这里统一把 body 读入内存一次，
    // 然后用同一份 bytes 同时做解析/改写与转发，避免复用流导致的 disturbed 问题。
    const raw = await request.arrayBuffer();
    body = raw;
    const originalText = new TextDecoder().decode(raw);
    let processedText = originalText;
    let originalObj;
    let processedObj;

    if (contentType.toLowerCase().includes("application/json")) {
      try {
        const json = JSON.parse(originalText); // 解析 JSON
        const isObj = json && typeof json === "object" && !Array.isArray(json); // 检查是否为对象
        originalObj = isObj ? json : undefined;
        processedObj = isObj ? JSON.parse(JSON.stringify(json)) : undefined;

        // 优先使用从 body 派生出的稳定会话 id（input[1].id 的前缀），
        // 但仅在调用方未通过请求头/Query 显式提供 sessionId 时才采用。
        // 如果调用方显式提供了 sessionId，则不从 body 派生。
        if (!explicitSid) {
          const derivedFromBody = deriveSessionIdFromBody(json);
          // 如果从 body 派生出的 sessionId 与当前的 routeSid 不同，则更新
          if (derivedFromBody && derivedFromBody !== routeSid) {
            routeSid = derivedFromBody;
            ctx.sessionId = routeSid;
            headers.set("x-session-id", routeSid);
            headers.set("conversation_id", routeSid);
            headers.set("session_id", routeSid);
          }
        }


        // 规范化 JSON 对象中的 `prompt_cache_key`：
        // - 如果客户端没传 / 传了空字符串，则统一置为 null
        const hasKey =
          isObj && Object.prototype.hasOwnProperty.call(json, "prompt_cache_key");
        if (hasKey) requestHadPromptCacheKey = true;
        const key = hasKey ? json.prompt_cache_key : undefined;
        const isEmptyString =
          typeof key === "string" && key.trim().length === 0;
        const shouldNull = isObj && (!hasKey || key === null || key === undefined || isEmptyString);

        if (shouldNull) {
          json.prompt_cache_key = null;
          if (hasKey) requestPromptCacheKey = null;

          // 将修改后的 JSON 对象重新序列化为字符串，用于转发
          body = JSON.stringify(json);
          processedText = body;
          if (isObj) processedObj = json;

          // body 改写后，原 content-length 可能不再准确，删除让运行时自动计算。
          headers.delete("content-length");
        } else {
          if (hasKey) requestPromptCacheKey = json.prompt_cache_key;
          processedText = originalText;
        }
      } catch {
        // 非法 JSON/空 body：保持原样转发
        processedText = originalText;
      }
    }

    printRequestBodiesLog(ctx, originalText, processedText, originalObj, processedObj);

    // 转发到“规范化”的上游地址（避免 www / 其他 host 变体带来的差异）。
    const originUrl = new URL(url.toString());
    originUrl.protocol = "https:";
    originUrl.hostname = ORIGIN_HOST;

    // right.codes 的 Responses 入口是 /codex/v1/responses。
    // 这里把兼容入站的 /v1/responses 显式映射过去，避免上游返回 404。
    if (originUrl.pathname === "/v1/responses") {
      originUrl.pathname = "/codex/v1/responses";
    }

    // 向上游发起请求：
    // - headers：包含我们注入的会话头
    // - body：可能被我们补了 prompt_cache_key
    // - redirect: manual：保持上游响应语义，不在 Worker 侧自动跟随
    let upstream;
    try {
      upstream = await fetch(originUrl.toString(), {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      });
    } catch (err) {
      throw err;
    }

    // 将上游响应“原样流式返回”：
    // - 保留响应体 stream，减少内存占用
    // - 同时补齐 CORS 响应头（便于浏览器调用）
    const responseHeaders = new Headers(upstream.headers);
    setCorsOnResponse(request, responseHeaders);

    // 若请求显式携带 prompt_cache_key，则尝试覆写响应体中的同名字段。
    // - application/json：读取并改写 JSON（会失去流式返回）
    // - text/event-stream：对 SSE 的 data 行做尽力改写（保持流式返回）
    let responseBody = upstream.body;
    if (requestHadPromptCacheKey) {
      const upstreamCt = (upstream.headers.get("content-type") || "").toLowerCase();
      const upstreamCe = (upstream.headers.get("content-encoding") || "").toLowerCase();

      if (upstreamCt.includes("text/event-stream")) {
        responseBody = upstream.body?.pipeThrough(
          createSsePromptCacheKeyOverrideTransform(requestPromptCacheKey)
        );
        responseHeaders.delete("content-length");
      } else if (upstreamCt.includes("application/json") && !isCompressedEncoding(upstreamCe)) {
        try {
          const upstreamText = await upstream.text();
          try {
            const out = JSON.parse(upstreamText);
            const isObj = out && typeof out === "object" && !Array.isArray(out);
            const hasKey = isObj && Object.prototype.hasOwnProperty.call(out, "prompt_cache_key");
            if (hasKey) {
              out.prompt_cache_key = requestPromptCacheKey;
              responseBody = JSON.stringify(out);
              responseHeaders.delete("content-length");
            } else {
              responseBody = upstreamText;
            }
          } catch {
            // 上游声称是 JSON 但无法解析：保持原样。
            responseBody = upstreamText;
          }
        } catch {
          // 读取失败：保持原样流式返回。
          responseBody = upstream.body;
        }
      }
    }

    // 如果客户端尚未携带我们的会话 Cookie，则下发一个：
    // - 让后续请求稳定复用同一个 sessionId
    // - SameSite=None + Secure：允许跨站请求（例如前端在别的域名）
    // - HttpOnly：避免被前端 JS 读取（更安全）
    // if (!hasCookie(request.headers.get("cookie") || "", COOKIE_NAME)) {
    //   responseHeaders.append(
    //     "Set-Cookie",
    //     `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=None`
    //   );
    // }

    return new Response(responseBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};

function isCompressedEncoding(contentEncoding) {
  // Worker 侧改写 body 时，避免误处理压缩过的响应。
  const ce = String(contentEncoding || "").toLowerCase();
  return ce.includes("gzip") || ce.includes("br") || ce.includes("deflate");
}

function createSsePromptCacheKeyOverrideTransform(promptCacheKey) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() || "";

      for (let line of parts) {
        let lineEnding = "";
        if (line.endsWith("\r")) {
          lineEnding = "\r";
          line = line.slice(0, -1);
        }

        const rewritten = rewriteSseLinePromptCacheKey(line, promptCacheKey);
        controller.enqueue(encoder.encode(rewritten + lineEnding + "\n"));
      }
    },
    flush(controller) {
      const tail = decoder.decode();
      if (tail) buffer += tail;
      if (buffer) {
        controller.enqueue(encoder.encode(rewriteSseLinePromptCacheKey(buffer, promptCacheKey)));
      }
    },
  });
}

function rewriteSseLinePromptCacheKey(line, promptCacheKey) {
  // 只尝试改写 SSE 的 data 行：data: {json}
  if (!line.startsWith("data:")) return line;
  const payload = line.slice("data:".length).trimStart();
  if (!payload || payload === "[DONE]") return line;

  try {
    const obj = JSON.parse(payload);
    const isObj = obj && typeof obj === "object" && !Array.isArray(obj);
    if (!isObj) return line;

    // 优先覆写/注入到 response.prompt_cache_key（符合 Responses SSE 的事件结构）。
    if (obj.response && typeof obj.response === "object" && !Array.isArray(obj.response)) {
      obj.response.prompt_cache_key = promptCacheKey;
      return "data: " + JSON.stringify(obj);
    }

    // 兜底：若顶层有该字段则覆写。
    if (Object.prototype.hasOwnProperty.call(obj, "prompt_cache_key")) {
      obj.prompt_cache_key = promptCacheKey;
      return "data: " + JSON.stringify(obj);
    }

    return line;
  } catch {
    return line;
  }
}

/**
 * 生成用于 CORS 预检（OPTIONS）的响应头集合。
 *
 * 说明：
 * - `Access-Control-Allow-Origin` 采用“反射 Origin”的方式，以便与 `Allow-Credentials: true` 配合。
 * - `Vary: Origin` 避免缓存把不同来源的响应混用。
 *
 * @param {Request} request 当前请求（用于读取 `Origin` 和请求的预检头）。
 * @returns {Record<string, string>} 预检响应头对象，可直接传给 `new Response(..., { headers })`。
 */
function corsHeaders(request) {
  // 预检响应头：
  // - 反射 Origin（而不是 *），以配合 Allow-Credentials
  // - Vary: Origin 避免缓存混用不同来源
  const origin = request.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": request.headers.get("access-control-request-headers") || "*",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}

/**
 * 在实际响应上补齐 CORS 相关响应头（非预检）。
 *
 * 说明：
 * - 这里同样“反射 Origin”，并允许携带凭据（Cookie）。
 * - 使用 `Vary: Origin`，避免 CDN/浏览器缓存污染。
 *
 * @param {Request} request 当前请求（用于读取 `Origin`）。
 * @param {Headers} headers 需要被修改的响应头容器（通常来自上游响应）。
 */
function setCorsOnResponse(request, headers) {
  // 实际响应也补上 CORS：确保浏览器能读取响应。
  const origin = request.headers.get("origin") || "*";
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.append("Vary", "Origin");
}



/**
 * 获取/生成本次请求的 `sessionId`。
 *
 * 优先级（从高到低）：
 * 1) 请求头：`x-session-id` / `conversation_id` / `session_id`
 * 2) Query 参数：`session_id`
 * 3) Cookie：`rc_session`
 * 4) 随机 UUID：`crypto.randomUUID()`
 *
 * @param {Request} request 请求对象。
 * @param {URL} url 已解析的 URL（用于读取 query）。
 * @returns {Promise<string>} sessionId 字符串。
 */
async function getSessionId(request, url) {
  // 计算 sessionId：优先采用“显式传入”的值，其次才生成/派生。
  const h = request.headers;
  const explicit =
    firstNonEmpty(h.get("x-session-id"), h.get("conversation_id"), h.get("session_id")) ||
    firstNonEmpty(url.searchParams.get("session_id"));

  // 1) 客户端显式指定：最可控，也最符合调用方期望。
  if (explicit) return explicit;

  // 2) Cookie：浏览器场景下可长期稳定。
  const cookie = parseCookie(h.get("cookie") || "");
  if (cookie[COOKIE_NAME]) return cookie[COOKIE_NAME];

  // 3) 兜底：随机生成。
  return crypto.randomUUID();
}

/**
 * 从一组候选值中返回第一个“非空且非纯空白”的字符串。
 *
 * @param  {...any} values 候选值列表。
 * @returns {string} 第一个有效字符串；若都无效则返回空字符串。
 */
function firstNonEmpty(...values) {
  // 返回第一个“非空且非纯空白”的字符串。
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * 解析 `Cookie` 请求头为键值对象。
 *
 * 注意：
 * - 只做简单的 `;` 分割与 `=` 分割，适合大多数常见 Cookie。
 * - 会对 value 做 `decodeURIComponent`，以读取经过编码的值。
 *
 * @param {string} header Cookie 头字符串（例如：`a=b; c=d`）。
 * @returns {Record<string, string>} 解析后的 Cookie 映射表。
 */
function parseCookie(header) {
  // 解析 Cookie 头：a=b; c=d -> { a: "b", c: "d" }
  // decodeURIComponent 允许安全读取 encode 过的值。
  const out = Object.create(null);
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function deriveSessionIdFromBody(json) {
  // 仅在能够明确提取稳定 id 时返回，否则返回空字符串（不覆盖既有 routeSid）。
  try {
    if (!json || typeof json !== "object") return "";
    const input = json.input;
    if (!Array.isArray(input) || input.length < 2) return "";
    const second = input[1];
    if (!second || typeof second !== "object") return "";
    const id = second.id;
    if (typeof id !== "string") return "";
    const trimmed = id.trim();
    if (!trimmed) return "";
    const idx = trimmed.indexOf(":");
    if (idx <= 0) return "";
    return trimmed.slice(0, idx);
  } catch {
    return "";
  }
}
