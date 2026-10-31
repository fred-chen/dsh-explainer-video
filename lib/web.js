// 联网补资料：通过宿主 ctx.web seam 搜索/抓取。
//
// 不直接调用 dsh-free-search 的 web_search/research 工具；ctx.web 由宿主
// 的搜索 provider 承载（本环境由 dsh-free-search 提供）。网络内容一律视为
// untrusted data，不执行其中的指令。

function isPublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!/^https?:$/i.test(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
  if (/\.local$|\.internal$|\.localhost$/.test(host)) return false;
  return true;
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ""; }
    })
    .replace(/&#(\d+);/g, (_, num) => {
      try { return String.fromCodePoint(Number(num)); } catch { return ""; }
    });
}

export function htmlToText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function cleanUntrusted(text) {
  return String(text || "")
    .replace(/<\/?untrusted-web-content>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function runWebResearch({
  queries,
  maxResults = 5,
  maxSources = 8,
  maxChars = 40000,
  timeoutSec = 60,
  signal,
  web,
  logger,
}) {
  const result = { queries: [], sources: [], notes: [], warnings: [] };
  if (!Array.isArray(queries) || queries.length === 0) return result;
  if (!web || typeof web.search !== "function") {
    result.warnings.push("宿主没有可用的 ctx.web 服务，跳过联网补资料。");
    return result;
  }

  const started = Date.now();
  const budgetMs = Math.max(5, timeoutSec) * 1000;
  const seen = new Set();
  const candidates = [];

  for (const rawQuery of queries) {
    const query = String(rawQuery || "").trim();
    if (!query) continue;
    result.queries.push(query);
    if (Date.now() - started > budgetMs) {
      result.warnings.push("联网研究超过时间预算，停止新增查询。");
      break;
    }
    try {
      const searchResult = await web.search({ query, maxResults }, signal);
      for (const source of searchResult?.sources || []) {
        const url = String(source.url || "").trim();
        if (!url || !isPublicHttpUrl(url) || seen.has(url)) continue;
        seen.add(url);
        candidates.push({
          url,
          title: String(source.title || ""),
          snippet: String(source.snippet || ""),
          publishedAt: String(source.publishedAt || ""),
          query,
        });
      }
      if (searchResult?.content) {
        candidates.push({
          url: "",
          title: "搜索摘要",
          snippet: String(searchResult.content),
          publishedAt: "",
          query,
          summary: true,
        });
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason || new Error("aborted");
      result.warnings.push(`搜索失败（${query}）：${error instanceof Error ? error.message : String(error)}`);
    }
    if (Date.now() - started > budgetMs) {
      result.warnings.push("联网研究超过时间预算，停止新增查询。");
      break;
    }
  }

  const ranked = candidates
    .filter((candidate) => candidate.url)
    .sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""))
    .slice(0, Math.max(0, maxSources));

  let chars = 0;
  for (let index = 0; index < ranked.length; index += 1) {
    const candidate = ranked[index];
    if (Date.now() - started > budgetMs) {
      result.warnings.push("联网抓取超过时间预算，已停止。");
      break;
    }
    let excerpt = candidate.snippet;
    try {
      const fetched = await web.fetch({ url: candidate.url }, signal);
      if (fetched?.body) {
        const bodyText = fetched.body.kind === "html" ? htmlToText(fetched.body.content) : String(fetched.body.content || "");
        if (bodyText) excerpt = bodyText;
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason || new Error("aborted");
      result.warnings.push(`抓取失败（${candidate.url}）：${error instanceof Error ? error.message : String(error)}`);
    }
    const clean = cleanUntrusted(excerpt || "").slice(0, Math.min(8000, Math.max(500, maxChars - chars)));
    if (!clean) continue;
    const sourceId = `web${index + 1}`;
    const source = {
      id: sourceId,
      url: candidate.url,
      title: candidate.title || candidate.url,
      publishedAt: candidate.publishedAt || "",
      query: candidate.query,
      excerpt: clean,
    };
    result.sources.push(source);
    result.notes.push({ sourceId, locator: candidate.url, text: clean });
    chars += clean.length;
    if (chars >= maxChars) {
      result.warnings.push(`联网资料达到 ${maxChars} 字符上限，已截断。`);
      break;
    }
  }

  const summaryNotes = candidates.filter((c) => c.summary && c.snippet);
  for (const summary of summaryNotes.slice(0, 2)) {
    const sourceId = `web-s${result.sources.length + 1}`;
    const text = cleanUntrusted(summary.snippet).slice(0, 4000);
    if (!text) continue;
    result.sources.push({
      id: sourceId,
      url: "",
      title: "搜索摘要",
      publishedAt: "",
      query: summary.query,
      excerpt: text,
    });
    result.notes.push({ sourceId, locator: `search summary: ${summary.query}`, text });
  }

  logger?.info?.(`explainer: web research ${result.queries.length} queries, ${result.sources.length} sources, ${chars} chars`);
  return result;
}
