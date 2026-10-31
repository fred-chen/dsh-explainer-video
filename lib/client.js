// dsh-explainer-video 客户端半：插件设置页 + 视频/分镜卡片。
window.__ModuleLoader__.load({
  id: "dsh-explainer-video",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const BRIDGE_PREFIX = "/api/dsh-explainer-video";
    const VOICES = [
      { value: "uncle_fu", label: "uncle_fu · 低沉醇厚成熟男声（中文）" },
      { value: "dylan", label: "dylan · 清亮北京年轻男声（中文·北京）" },
      { value: "eric", label: "eric · 沙哑明亮成都男声（中文·四川）" },
      { value: "vivian", label: "vivian · 明亮微锋锐年轻女声（中文）" },
      { value: "serena", label: "serena · 温暖柔和年轻女声（中文）" },
      { value: "ryan", label: "ryan · 节奏感动态男声（英文）" },
      { value: "aiden", label: "aiden · 阳光美式男声（英文）" },
      { value: "ono_anna", label: "ono_anna · 轻快俏皮女声（日语）" },
      { value: "sohee", label: "sohee · 温暖情感丰富女声（韩语）" },
    ];
    const FORMATS = ["wav", "mp3", "flac", "pcm", "aac", "opus"];
    const STYLES = [
      { value: "dark-neon", label: "dark-neon · 暗色霓虹手绘信息图" },
      { value: "tech-blue", label: "tech-blue · 科技蓝冷静图表" },
      { value: "paper-editorial", label: "paper-editorial · 纸面编辑部高对比" },
    ];
    const WEB_MODES = [
      { value: "auto", label: "auto · 按需联网补资料" },
      { value: "off", label: "off · 只用素材" },
      { value: "always", label: "always · 强制联网检索" },
    ];
    const LANGUAGES = ["", "zh", "en", "ja", "ko"];
    const SUBTITLE_MODES = [
      { value: "none", label: "none · 不烧录字幕" },
      { value: "burn", label: "burn · 画面内绘制字幕" },
      { value: "srt", label: "srt · 生成 SRT 旁挂文件" },
    ];

    //#region styles
    (function injectStyles() {
      if (typeof document === "undefined") return;
      if (document.getElementById("dev-styles")) return;
      const css = [
        ".dev-set-page{display:flex;flex-direction:column;gap:16px;color:inherit;font-size:14px;line-height:1.55}",
        ".dev-set-card{border:1px solid rgba(0,0,0,.08);border-radius:12px;background:rgba(255,255,255,.72);padding:14px 16px;display:flex;flex-direction:column;gap:10px}",
        "@media (prefers-color-scheme: dark){.dev-set-card{background:rgba(30,30,32,.7);border-color:rgba(255,255,255,.08)}}",
        ".dev-set-title{font-weight:600;font-size:14px;margin:0}",
        ".dev-set-hint{color:#6e6e73;font-size:12px;margin:0;white-space:pre-wrap}",
        "@media (prefers-color-scheme: dark){.dev-set-hint{color:#a1a1a6}}",
        ".dev-set-error{color:#dc2626;font-size:12px;margin:0;white-space:pre-wrap}",
        "@media (prefers-color-scheme: dark){.dev-set-error{color:#f87171}}",
        ".dev-set-ok{color:#16a34a;font-size:12px;margin:0;white-space:pre-wrap}",
        "@media (prefers-color-scheme: dark){.dev-set-ok{color:#4ade80}}",
        ".dev-set-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}",
        ".dev-set-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
        ".dev-set-label{font-size:12px;font-weight:500;color:#3a3a3c;display:flex;align-items:center;gap:6px}",
        "@media (prefers-color-scheme: dark){.dev-set-label{color:#d1d1d6}}",
        ".dev-set-input,.dev-set-select{width:100%;box-sizing:border-box;border:1px solid rgba(0,0,0,.12);border-radius:8px;padding:6px 10px;font:inherit;font-size:13px;color:inherit;background:rgba(0,0,0,.03)}",
        "@media (prefers-color-scheme: dark){.dev-set-input,.dev-set-select{border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.05)}}",
        ".dev-set-input:focus-visible,.dev-set-select:focus-visible{outline:none;border-color:#0071e3}",
        ".dev-set-btn{border:1px solid rgba(0,0,0,.14);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer;background:transparent;color:inherit}",
        ".dev-set-btn:hover:not(:disabled){background:rgba(0,0,0,.05)}",
        "@media (prefers-color-scheme: dark){.dev-set-btn:hover:not(:disabled){background:rgba(255,255,255,.07)}}",
        ".dev-set-btnPrimary{background:#0071e3;border-color:#0071e3;color:#fff}",
        ".dev-set-btnPrimary:hover:not(:disabled){background:#0a84ff}",
        ".dev-set-btn:disabled{opacity:.5;cursor:default}",
        ".dev-set-toggle{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}",
        ".dev-set-result{border:1px dashed rgba(0,0,0,.15);border-radius:10px;padding:10px 12px;font-size:12px;white-space:pre-wrap;word-break:break-word;color:inherit}",
        "@media (prefers-color-scheme: dark){.dev-set-result{border-color:rgba(255,255,255,.18)}}",
        ".dev-set-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(0,113,227,.12);color:#0071e3}",
        "@media (prefers-color-scheme: dark){.dev-set-chip{color:#60a5fa}}",
        ".dev-card{display:flex;flex-direction:column;gap:10px;padding:8px 0 4px;max-width:720px}",
        ".dev-video{display:block;width:100%;max-height:380px;border-radius:10px;background:#000;border:1px solid rgba(0,0,0,.12)}",
        ".dev-preview-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}",
        ".dev-preview{display:block;width:100%;border-radius:8px;border:1px solid rgba(0,0,0,.12);background:#000}",
        ".dev-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center}",
        ".dev-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(0,0,0,.06);color:#3a3a3c}",
        "@media (prefers-color-scheme: dark){.dev-chip{background:rgba(255,255,255,.08);color:#d1d1d6}}",
        ".dev-chipOk{background:rgba(22,163,74,.12);color:#15803d}",
        "@media (prefers-color-scheme: dark){.dev-chipOk{color:#4ade80}}",
        ".dev-chipWarn{background:rgba(245,158,11,.14);color:#b45309}",
        "@media (prefers-color-scheme: dark){.dev-chipWarn{color:#f59e0b}}",
        ".dev-path{font-family:monospace;font-size:11px;color:#6e6e73;overflow-wrap:anywhere}",
        "@media (prefers-color-scheme: dark){.dev-path{color:#a1a1a6}}",
        ".dev-pending{display:flex;flex-direction:column;gap:5px;padding:4px 0}",
        ".dev-pending-title{font-weight:600;font-size:13px}",
        ".dev-hint{color:#6e6e73;font-size:12px;white-space:pre-wrap}",
        "@media (prefers-color-scheme: dark){.dev-hint{color:#a1a1a6}}",
        ".dev-error{color:#dc2626;font-size:12px;white-space:pre-wrap}",
        "@media (prefers-color-scheme: dark){.dev-error{color:#f87171}}",
        ".dev-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
        ".dev-link,.dev-btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;cursor:pointer;text-decoration:none}",
        ".dev-link{border:1px solid rgba(0,113,227,.35);color:#0071e3;background:rgba(0,113,227,.06)}",
        ".dev-btn{border:1px solid rgba(0,0,0,.14);color:inherit;background:transparent}",
        "@media (prefers-color-scheme: dark){.dev-btn{border-color:rgba(255,255,255,.14)}}",
      ].join("\n");
      const style = document.createElement("style");
      style.id = "dev-styles";
      style.textContent = css;
      document.head.appendChild(style);
    })();
    //#endregion

    //#region bridge
    async function bridgeCall(path, options) {
      let response;
      try {
        response = await fetch(`${BRIDGE_PREFIX}${path}`, options);
      } catch (error) {
        return { ok: false, code: "network", message: "无法连接宿主接口：" + (error && error.message ? error.message : String(error)) };
      }
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok) {
        const detail = body && (body.message || body.error);
        return { ok: false, code: "http-" + response.status, message: `接口返回 ${response.status}${detail ? "：" + detail : ""}` };
      }
      if (body === null || typeof body !== "object") {
        return { ok: false, code: "bad-response", message: "接口返回了无法解析的内容（宿主插件版本与页面不一致，请重载后重试）" };
      }
      return body;
    }
    const bridgeConfig = () => bridgeCall("/config", { method: "GET" });
    const bridgeSave = (payload) => bridgeCall("/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    const bridgeTest = (payload) => bridgeCall("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    //#endregion

    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function Field(label, control, hint) {
      return h("div", { className: "dev-set-field" },
        h("label", { className: "dev-set-label" }, label, hint ? h("span", { className: "dev-set-chip" }, hint) : null),
        control);
    }

    function TextInput(props) {
      return h("input", {
        className: "dev-set-input",
        type: props.type || "text",
        value: props.value ?? "",
        placeholder: props.placeholder || "",
        autoComplete: props.type === "password" ? "off" : undefined,
        onChange: (event) => props.onChange(event.target.value),
      });
    }

    function NumberInput(props) {
      return h("input", {
        className: "dev-set-input",
        type: "number",
        min: props.min ?? 0,
        max: props.max ?? undefined,
        step: props.step ?? 1,
        value: props.value ?? "",
        onChange: (event) => props.onChange(event.target.value),
      });
    }

    function Select(props) {
      return h("select", {
        className: "dev-set-select",
        value: props.value ?? "",
        onChange: (event) => props.onChange(event.target.value),
      }, (props.options || []).map((option) => h("option", { key: option.value, value: option.value }, option.label)));
    }

    function Toggle(props) {
      return h("label", { className: "dev-set-toggle" },
        h("input", { type: "checkbox", checked: props.checked === true, onChange: (event) => props.onChange(event.target.checked) }),
        props.label);
    }

    function SettingsCard() {
      const [data, setData] = useState(null);
      const [config, setConfig] = useState(null);
      const [status, setStatus] = useState({ kind: "", text: "" });
      const [busy, setBusy] = useState(false);
      const [probe, setProbe] = useState(null);

      const load = useCallback(async () => {
        const out = await bridgeConfig();
        if (!out.ok) {
          setStatus({ kind: "error", text: out.message || "读取配置失败" });
          return;
        }
        const value = out.value;
        const cfg = clone(value.config || {});
        const secrets = Array.isArray(value.secrets) ? value.secrets : [];
        const secretSet = (pathName) => secrets.some((secret) => Array.isArray(secret.path) && secret.path.join(".") === pathName && secret.set);
        cfg.ttsApiKey = "";
        cfg.ttsApiKeySet = secretSet("ttsApiKey");
        cfg.clearTtsApiKey = false;
        cfg.asrApiKey = "";
        cfg.asrApiKeySet = secretSet("asrApiKey");
        cfg.clearAsrApiKey = false;
        if (cfg.ttsVoice && !VOICES.some((voice) => voice.value === cfg.ttsVoice)) {
          cfg._customVoice = cfg.ttsVoice;
          cfg.ttsVoice = "__custom__";
        }
        if (cfg.ttsVoice === undefined) cfg.ttsVoice = "uncle_fu";
        if (cfg.webMode === undefined) cfg.webMode = "auto";
        setData(value);
        setConfig(cfg);
      }, []);

      useEffect(() => { void load(); }, [load]);

      const update = (patch) => setConfig((previous) => ({ ...previous, ...patch }));

      const save = useCallback(async () => {
        if (!config) return;
        setBusy(true);
        setStatus({ kind: "", text: "" });
        const payload = {
          enabled: config.enabled,
          llmProvider: config.llmProvider,
          llmModel: config.llmModel,
          llmMaxTokens: Number(config.llmMaxTokens),
          language: config.language,
          ttsEndpoint: config.ttsEndpoint,
          ttsModel: config.ttsModel,
          ttsVoice: config.ttsVoice === "__custom__" ? String(config._customVoice || "").trim() : config.ttsVoice,
          ttsLanguage: config.ttsLanguage,
          ttsInstructions: config.ttsInstructions,
          ttsFormat: config.ttsFormat,
          ttsSampleRate: Number(config.ttsSampleRate) || 0,
          ttsTimeoutSec: Number(config.ttsTimeoutSec),
          ttsExtraParams: config.ttsExtraParams || "",
          webMode: config.webMode,
          webMaxQueries: Number(config.webMaxQueries),
          webMaxSources: Number(config.webMaxSources),
          webMaxChars: Number(config.webMaxChars),
          webTimeoutSec: Number(config.webTimeoutSec),
          asrEndpoint: config.asrEndpoint,
          asrModel: config.asrModel,
          stylePreset: config.stylePreset,
          width: Number(config.width),
          height: Number(config.height),
          fps: Number(config.fps),
          targetDurationSec: Number(config.targetDurationSec),
          sceneGapSec: Number(config.sceneGapSec),
          fontFamily: config.fontFamily,
          outputDir: config.outputDir,
          maxSourceChars: Number(config.maxSourceChars),
          subtitleMode: config.subtitleMode,
          bgmPath: config.bgmPath,
          bgmVolume: Number(config.bgmVolume),
          timeoutSec: Number(config.timeoutSec),
          keepWorkDir: config.keepWorkDir,
          expectedRevision: data && data.revision,
        };
        if (config.ttsApiKey) payload.ttsApiKey = config.ttsApiKey;
        if (config.clearTtsApiKey) payload.clearTtsApiKey = true;
        if (config.asrApiKey) payload.asrApiKey = config.asrApiKey;
        if (config.clearAsrApiKey) payload.clearAsrApiKey = true;
        const out = await bridgeSave(payload);
        setBusy(false);
        if (!out.ok) {
          setStatus({ kind: "error", text: out.message || "保存失败" });
          return;
        }
        setStatus({ kind: "ok", text: "已保存，立即生效。" });
        await load();
      }, [config, data, load]);

      const test = useCallback(async () => {
        if (!config) return;
        setBusy(true);
        setStatus({ kind: "", text: "" });
        const out = await bridgeTest({
          ttsEndpoint: config.ttsEndpoint,
          ttsModel: config.ttsModel,
          ttsApiKey: config.ttsApiKey || undefined,
        });
        setBusy(false);
        if (!out.ok) {
          setStatus({ kind: "error", text: out.message || "测试失败" });
          return;
        }
        setProbe(out.value);
      }, [config]);

      if (!config) {
        return h("div", { className: "dev-set-card" },
          h("p", { className: "dev-set-hint" }, status.kind === "error" ? status.text : "正在读取配置…"));
      }

      const services = data?.services || {};
      const voiceOptions = [
        { value: "", label: "（默认 uncle_fu）" },
        { value: "__custom__", label: "自定义描述（VoiceDesign 用）" },
        ...VOICES,
      ];
      const voiceSelectValue = config.ttsVoice === "__custom__" ? "__custom__" : config.ttsVoice;

      return h("div", { className: "dev-set-page" },
        h("div", { className: "dev-set-card" },
          h("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
            h(Toggle, {
              checked: config.enabled !== false,
              label: "启用 explainer 工具",
              onChange: (value) => update({ enabled: value }),
            }),
            h("span", { style: { flex: 1 } }),
            h("span", { className: "dev-set-chip" }, "v" + (data?.version || "0.1.0")),
            h("span", { className: "dev-set-chip" }, services.llm ? "LLM 可用" : "LLM 不可用"),
            h("span", { className: "dev-set-chip" }, services.web ? "web 可用" : "web 不可用")
          ),
          h("p", { className: "dev-set-hint" },
            "提示词 + 素材 → 当前会话主模型生成分镜 → TTS 预置音色配音 → SVG 动画 → MP4。LLM 默认延续当前会话主模型；llmProvider/llmModel 留空即可。")
        ),

        h("div", { className: "dev-set-card" },
          h("h3", { className: "dev-set-title" }, "LLM（默认当前会话主模型）"),
          h("div", { className: "dev-set-grid" },
            Field("Provider（留空=当前 Agent）",
              h(TextInput, { value: config.llmProvider, placeholder: "留空 = 当前会话主模型", onChange: (value) => update({ llmProvider: value }) }),
              "例如 deepseek-official"),
            Field("Model（留空=当前 Agent）",
              h(TextInput, { value: config.llmModel, placeholder: "留空 = 当前会话主模型", onChange: (value) => update({ llmModel: value }) })),
            Field("最大输出 tokens",
              h(NumberInput, { value: config.llmMaxTokens, min: 1024, max: 131072, onChange: (value) => update({ llmMaxTokens: value }) })),
            Field("默认语言",
              h(Select, {
                value: config.language,
                options: LANGUAGES.map((lang) => ({ value: lang, label: lang || "（zh 默认）" })),
                onChange: (value) => update({ language: value }),
              }))
          )
        ),

        h("div", { className: "dev-set-card" },
          h("h3", { className: "dev-set-title" }, "TTS 端点与预置音色（对齐 dsh-tts）"),
          h("div", { className: "dev-set-grid" },
            Field("API 端点 URL",
              h(TextInput, { value: config.ttsEndpoint, placeholder: "http://ai4090:8080/v1/audio", onChange: (value) => update({ ttsEndpoint: value }) }),
              "接受 origin / /v1 / /v1/audio / /v1/audio/speech"),
            Field("模型",
              h(TextInput, { value: config.ttsModel, placeholder: "Qwen3-TTS-12Hz-1.7B-CustomVoice", onChange: (value) => update({ ttsModel: value }) }),
              "可切 ...-VoiceDesign"),
            Field("默认音色（预置角色）",
              h(Select, { value: voiceSelectValue, options: voiceOptions, onChange: (value) => update({ ttsVoice: value }) }),
              "CustomVoice 用预置；VoiceDesign 可填自由描述"),
            Field("语言（留空自动）",
              h(Select, {
                value: config.ttsLanguage,
                options: LANGUAGES.map((lang) => ({ value: lang, label: lang || "（自动）" })),
                onChange: (value) => update({ ttsLanguage: value }),
              }))
          ),
          config.ttsVoice === "__custom__"
            ? Field("自定义音色描述",
                h(TextInput, { value: config._customVoice, placeholder: "一位低沉沙哑的中年男声，语速偏慢", onChange: (value) => update({ _customVoice: value }) }),
                "仅 VoiceDesign 模型使用")
            : null,
          Field("风格/情绪/语速指令",
            h(TextInput, { value: config.ttsInstructions, placeholder: "沉稳、清晰、纪录片式旁白，语速适中", onChange: (value) => update({ ttsInstructions: value }) })),
          h("div", { className: "dev-set-grid" },
            Field("输出格式", h(Select, { value: config.ttsFormat, options: FORMATS.map((format) => ({ value: format, label: format })), onChange: (value) => update({ ttsFormat: value }) })),
            Field("采样率", h(Select, {
              value: String(config.ttsSampleRate),
              options: [
                { value: "0", label: "原生（默认）" },
                { value: "8000", label: "8000 Hz" },
                { value: "24000", label: "24000 Hz" },
              ],
              onChange: (value) => update({ ttsSampleRate: Number(value) }),
            })),
            Field("超时（秒）", h(NumberInput, { value: config.ttsTimeoutSec, min: 10, max: 3600, onChange: (value) => update({ ttsTimeoutSec: value }) }))
          ),
          Field("API Key（可选，secret）",
            h(TextInput, {
              type: "password",
              value: config.ttsApiKey,
              placeholder: config.ttsApiKeySet ? "已保存（留空保持不变，输入新值覆盖）" : "留空 = 不发送鉴权头",
              onChange: (value) => update({ ttsApiKey: value }),
            })),
          config.ttsApiKeySet
            ? Toggle({ checked: config.clearTtsApiKey === true, label: "清除已保存的 TTS API Key", onChange: (value) => update({ clearTtsApiKey: value }) })
            : null
        ),

        h("div", { className: "dev-set-card" },
          h("h3", { className: "dev-set-title" }, "联网补资料"),
          h("p", { className: "dev-set-hint" },
            "引用主要来自素材；auto 只在需要时联网补充/对照。网络来源会写入 web-research.json 并在画面 source/片尾 references 中标注。"),
          h("div", { className: "dev-set-grid" },
            Field("模式", h(Select, { value: config.webMode, options: WEB_MODES, onChange: (value) => update({ webMode: value }) })),
            Field("最多查询", h(NumberInput, { value: config.webMaxQueries, min: 0, max: 12, onChange: (value) => update({ webMaxQueries: value }) })),
            Field("最多来源", h(NumberInput, { value: config.webMaxSources, min: 0, max: 20, onChange: (value) => update({ webMaxSources: value }) })),
            Field("最多字符", h(NumberInput, { value: config.webMaxChars, min: 0, max: 200000, onChange: (value) => update({ webMaxChars: value }) })),
            Field("时间预算（秒）", h(NumberInput, { value: config.webTimeoutSec, min: 5, max: 300, onChange: (value) => update({ webTimeoutSec: value }) }))
          )
        ),

        h("div", { className: "dev-set-card" },
          h("h3", { className: "dev-set-title" }, "渲染与输出"),
          h("div", { className: "dev-set-grid" },
            Field("风格", h(Select, { value: config.stylePreset, options: STYLES, onChange: (value) => update({ stylePreset: value }) })),
            Field("宽", h(NumberInput, { value: config.width, min: 320, max: 3840, onChange: (value) => update({ width: value }) })),
            Field("高", h(NumberInput, { value: config.height, min: 240, max: 2160, onChange: (value) => update({ height: value }) })),
            Field("帧率", h(NumberInput, { value: config.fps, min: 12, max: 60, onChange: (value) => update({ fps: value }) })),
            Field("目标时长（秒）", h(NumberInput, { value: config.targetDurationSec, min: 20, max: 1200, onChange: (value) => update({ targetDurationSec: value }) })),
            Field("场景间隙（秒）", h(NumberInput, { value: config.sceneGapSec, min: 0, max: 2, step: 0.1, onChange: (value) => update({ sceneGapSec: value }) })),
            Field("字幕模式", h(Select, { value: config.subtitleMode, options: SUBTITLE_MODES, onChange: (value) => update({ subtitleMode: value }) })),
            Field("字体栈", h(TextInput, { value: config.fontFamily, onChange: (value) => update({ fontFamily: value }) })),
            Field("输出目录", h(TextInput, { value: config.outputDir, placeholder: ".dsh-explainer-video", onChange: (value) => update({ outputDir: value }) })),
            Field("素材字符上限", h(NumberInput, { value: config.maxSourceChars, min: 1000, max: 500000, onChange: (value) => update({ maxSourceChars: value }) })),
            Field("BGM 路径", h(TextInput, { value: config.bgmPath, placeholder: "可选本地音频", onChange: (value) => update({ bgmPath: value }) })),
            Field("BGM 音量", h(NumberInput, { value: config.bgmVolume, min: 0, max: 1, step: 0.01, onChange: (value) => update({ bgmVolume: value }) })),
            Field("总超时（秒）", h(NumberInput, { value: config.timeoutSec, min: 60, max: 3600, onChange: (value) => update({ timeoutSec: value }) }))
          ),
          Toggle({ checked: config.keepWorkDir !== false, label: "保留中间文件（分镜、音频、预览）", onChange: (value) => update({ keepWorkDir: value }) })
        ),

        h("div", { className: "dev-set-card" },
          h("h3", { className: "dev-set-title" }, "测试连通性"),
          h("div", { className: "dev-set-actions" },
            h("button", { className: "dev-set-btn", type: "button", disabled: busy, onClick: () => void test() }, "测试 TTS / 媒体工具"),
            h("button", { className: "dev-set-btn dev-set-btnPrimary", type: "button", disabled: busy, onClick: () => void save() }, "保存"),
            h("button", { className: "dev-set-btn", type: "button", disabled: busy, onClick: () => void load() }, "重新读取")
          ),
          h("p", { className: "dev-set-hint" }, "测试会读取 /v1/models 与 /v1/audio/voices，不会生成音频。"),
          probe ? h("div", { className: "dev-set-result" },
            `端点：${probe.endpoint}`,
            `\n模型：${(probe.models || []).map((model) => `${model.id}(${model.status})`).join("、") || "无"}${probe.modelsError ? " / " + probe.modelsError : ""}`,
            `\n音色：${(probe.voices || []).join("、") || "无"}${probe.voicesError ? " / " + probe.voicesError : ""}`,
            `\nffmpeg：${probe.ffmpeg || probe.ffmpegError || "不可用"}`,
            `\nffprobe：${probe.ffprobe || probe.ffprobeError || "不可用"}`,
            `\nsharp/libvips：${probe.sharpVersion}`,
            `\nLLM：${probe.llmAvailable ? "可用" : "不可用"} · web：${probe.webAvailable ? "可用" : "不可用"}`) : null
        ),

        h("div", { className: "dev-set-card" },
          status.kind === "error" ? h("p", { className: "dev-set-error" }, status.text) : null,
          status.kind === "ok" ? h("p", { className: "dev-set-ok" }, status.text) : null
        )
      );
    }

    function flattenText(block) {
      const content = block && block.content;
      if (!Array.isArray(content)) return "";
      return content.filter((part) => part && part.type === "text").map((part) => part.text).join("\n");
    }

    function ExplainerToolView(props) {
      const { phase, block, openFile } = props;
      if (phase !== "result") {
        const args = block && block.args && typeof block.args === "object" ? block.args : {};
        return h("div", { className: "dev-pending" },
          h("div", { className: "dev-pending-title" }, "生成科普视频"),
          args.prompt ? h("div", { className: "dev-hint" }, String(args.prompt).slice(0, 240)) : null,
          h("div", { className: "dev-hint" }, args.planOnly ? "生成分镜与预览图…" : "生成分镜、配音与视频…"));
      }
      if (block && block.isError) {
        return h("div", { className: "dev-pending" },
          h("div", { className: "dev-pending-title" }, "科普视频生成失败"),
          h("div", { className: "dev-error" }, flattenText(block) || "unknown error"));
      }
      const meta = block && block.meta && typeof block.meta === "object" ? block.meta : null;
      if (!meta) {
        return h("div", { className: "dev-pending" }, h("div", { className: "dev-hint" }, flattenText(block) || "结果不可用"));
      }
      const warnings = Array.isArray(meta.warnings) ? meta.warnings : [];
      const chips = [];
      if (meta.planOnly) chips.push(h("span", { className: "dev-chip" }, "仅分镜"));
      if (Number.isFinite(Number(meta.durationSec))) chips.push(h("span", { className: "dev-chip" }, `${Number(meta.durationSec)}s`));
      if (Number.isFinite(Number(meta.sceneCount))) chips.push(h("span", { className: "dev-chip" }, `${Number(meta.sceneCount)} 场景`));
      if (meta.style) chips.push(h("span", { className: "dev-chip" }, String(meta.style)));
      if (meta.voice) chips.push(h("span", { className: "dev-chip" }, String(meta.voice)));
      if (meta.ttsModel) chips.push(h("span", { className: "dev-chip" }, String(meta.ttsModel)));
      chips.push(warnings.length ? h("span", { className: "dev-chip dev-chipWarn" }, "有警告") : h("span", { className: "dev-chip dev-chipOk" }, "完成"));

      return h("div", { className: "dev-card" },
        meta.url ? h("video", { className: "dev-video", src: meta.url, controls: true, preload: "metadata", playsInline: true }) : null,
        meta.previewUrls && meta.previewUrls.length > 0
          ? h("div", { className: "dev-preview-grid" },
              meta.previewUrls.map((url) => h("img", { key: url, className: "dev-preview", src: url, alt: "storyboard preview" })))
          : null,
        h("div", { className: "dev-meta" }, ...chips),
        meta.storyboardPath ? h("div", { className: "dev-path" }, String(meta.storyboardPath)) : null,
        meta.scriptPath ? h("div", { className: "dev-path" }, String(meta.scriptPath)) : null,
        warnings.length ? h("div", { className: "dev-error" }, warnings.join("\n")) : null,
        h("div", { className: "dev-actions" },
          meta.url ? h("a", { className: "dev-link", href: meta.url, download: true }, "下载 MP4") : null,
          typeof openFile === "function" && meta.filePath
            ? h("button", { className: "dev-btn", type: "button", onClick: () => openFile(meta.filePath) }, "打开文件")
            : null,
          typeof openFile === "function" && meta.storyboardPath
            ? h("button", { className: "dev-btn", type: "button", onClick: () => openFile(meta.storyboardPath) }, "打开分镜")
            : null,
          typeof openFile === "function" && meta.subtitlePath
            ? h("button", { className: "dev-btn", type: "button", onClick: () => openFile(meta.subtitlePath) }, "打开字幕")
            : null
        )
      );
    }

    function summaryText() {
      return "矢量科普视频 · 素材 + 联网补资料 + 当前会话主模型 + TTS 预置音色 + SVG 动画";
    }

    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("plugins.row.config", () =>
        ctx.slots.register(
          { name: "plugins.row.config", key: "dsh-explainer-video#explainer-video" },
          (slotProps) => slotProps && slotProps.view === "summary" ? summaryText() : h(SettingsCard, null)
        ));
      ctx.slots.inject("tool.call.toolview", () => {
        const disposers = [
          ctx.slots.register(
            { name: "tool.call.toolview", key: "explainer_video_generate", priority: -10 },
            ExplainerToolView
          ),
          ctx.slots.register(
            { name: "tool.call.toolview", key: "explainer_video_render", priority: -10 },
            ExplainerToolView
          ),
        ];
        return () => disposers.forEach((dispose) => dispose());
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
