import { useState } from "react";
import { PROVIDER_DEFAULTS } from "../coach/adapters";
import {
  buildOllamaOriginSetup,
  detectOllamaEnvironmentNotice,
} from "../coach/diagnostics";
import { SHARED_DEVICE_SECRET_WARNING } from "../coach/secretStorage";
import type {
  CoachCadence,
  CoachDiagnostic,
  CoachProviderId,
  CoachSettings,
} from "../coach/types";

export interface CoachSettingsSectionProps {
  settings: CoachSettings;
  apiKey: string;
  currentOrigin?: string;
  userAgent?: string;
  diagnostic?: CoachDiagnostic | null;
  pkceStatus?: string | null;
  testingConnection?: boolean;
  onChangeSettings: (next: CoachSettings) => void;
  onChangeApiKey: (key: string) => void;
  onClearApiKey: () => void;
  onStartOpenRouterPkce?: () => void;
  onExchangeOpenRouterPkceCode?: (code: string) => void;
  onTestConnection?: () => void;
}

const PROVIDERS: CoachProviderId[] = [
  "openrouter",
  "gemini",
  "openai",
  "anthropic",
  "ollama",
  "custom",
];

/**
 * BYOK / Ollama External-Focus Coach settings & connectivity diagnostics wizard
 * mounted inside PracticeSettingsModal.
 */
export function CoachSettingsSection({
  settings,
  apiKey,
  currentOrigin,
  userAgent,
  diagnostic = null,
  pkceStatus = null,
  testingConnection = false,
  onChangeSettings,
  onChangeApiKey,
  onClearApiKey,
  onStartOpenRouterPkce,
  onExchangeOpenRouterPkceCode,
  onTestConnection,
}: CoachSettingsSectionProps) {
  const [pkceCodeDraft, setPkceCodeDraft] = useState("");
  const providerMeta = PROVIDER_DEFAULTS[settings.provider];
  const ollamaSetup = buildOllamaOriginSetup(currentOrigin);
  const ollamaEnvNotice = detectOllamaEnvironmentNotice({ currentOrigin, userAgent });

  const handleProviderChange = (nextProvider: CoachProviderId) => {
    const prevDefault = PROVIDER_DEFAULTS[settings.provider].defaultModel;
    const nextMeta = PROVIDER_DEFAULTS[nextProvider];
    const shouldReplaceModel = !settings.model || settings.model === prevDefault;
    onChangeSettings({
      ...settings,
      provider: nextProvider,
      model: shouldReplaceModel ? nextMeta.defaultModel : settings.model,
    });
  };

  return (
    <div
      data-testid="coach-settings-section"
      className="space-y-2.5 rounded-lg border border-teal-200/80 bg-teal-50/35 p-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-teal-950">
            External-Focus Coach（外部注意 AI 教练）
          </div>
          <div className="text-[11px] text-slate-600">
            离线 0 ms 本地模板永久可用；开启后仅发送 ~300 tokens 封闭世界声学摘要，绝不发送原始 MIDI。
          </div>
        </div>
        <input
          type="checkbox"
          data-testid="coach-enabled-toggle"
          aria-label="启用外部注意 AI 教练"
          checked={settings.enabled}
          onChange={(e) => onChangeSettings({ ...settings, enabled: e.target.checked })}
          className="h-4 w-4 shrink-0 accent-teal-600"
        />
      </div>

      <div className="grid grid-cols-1 gap-2 border-t border-teal-200/60 pt-2 sm:grid-cols-2">
        <div>
          <label htmlFor="coach-provider-select" className="block font-medium text-slate-900">
            模型服务商（BYOK / 本地）
          </label>
          <select
            id="coach-provider-select"
            data-testid="coach-provider-select"
            aria-label="模型服务商"
            value={settings.provider}
            onChange={(e) => handleProviderChange(e.target.value as CoachProviderId)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800"
          >
            {PROVIDERS.map((id) => (
              <option key={id} value={id}>
                {PROVIDER_DEFAULTS[id].label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="coach-model-input" className="block font-medium text-slate-900">
            模型名称
          </label>
          <input
            id="coach-model-input"
            data-testid="coach-model-input"
            type="text"
            value={settings.model}
            placeholder={providerMeta.defaultModel}
            onChange={(e) => onChangeSettings({ ...settings, model: e.target.value })}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800"
          />
        </div>
      </div>

      {(settings.provider === "custom" || settings.provider === "ollama" || settings.baseUrl) && (
        <div>
          <label htmlFor="coach-baseurl-input" className="block font-medium text-slate-900">
            {settings.provider === "custom" ? "兼容 Base URL（必填）" : "自定义 Base URL（可选）"}
          </label>
          <input
            id="coach-baseurl-input"
            data-testid="coach-baseurl-input"
            type="text"
            value={settings.baseUrl}
            placeholder={providerMeta.endpoint || "https://your-gateway.example/v1"}
            onChange={(e) => onChangeSettings({ ...settings, baseUrl: e.target.value })}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800"
          />
        </div>
      )}

      {providerMeta.requiresKey && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="coach-apikey-input" className="font-medium text-slate-900">
              API Key（仅存浏览器会话，绝不进备份）
            </label>
            {apiKey && (
              <button
                type="button"
                data-testid="coach-clear-key-btn"
                onClick={onClearApiKey}
                className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-100"
              >
                清除密钥
              </button>
            )}
          </div>
          <input
            id="coach-apikey-input"
            data-testid="coach-apikey-input"
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder="输入您的 BYOK API Key（通过请求头传输，绝不走 URL 参数）"
            onChange={(e) => onChangeApiKey(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800"
          />

          <label className="flex cursor-pointer items-start gap-2 rounded border border-slate-200 bg-white/80 p-2">
            <input
              type="checkbox"
              data-testid="coach-remember-key-toggle"
              checked={settings.keyStorageMode === "local"}
              onChange={(e) =>
                onChangeSettings({
                  ...settings,
                  keyStorageMode: e.target.checked ? "local" : "session",
                })
              }
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-teal-600"
            />
            <span className="text-[11px] text-slate-600">
              <strong className="text-slate-800">在本设备记住密钥（localStorage）</strong>：默认仅存于当前标签页（sessionStorage，关标签即销毁）。{SHARED_DEVICE_SECRET_WARNING}
            </span>
          </label>
        </div>
      )}

      {settings.provider === "openrouter" && (
        <div
          data-testid="coach-pkce-section"
          className="space-y-1.5 rounded border border-slate-200 bg-white p-2 text-[11px]"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-slate-800">OpenRouter OAuth PKCE 免手抄登录</span>
            {onStartOpenRouterPkce && (
              <button
                type="button"
                data-testid="coach-pkce-start-btn"
                onClick={onStartOpenRouterPkce}
                className="rounded border border-teal-400 bg-teal-50 px-2 py-1 text-[11px] font-semibold text-teal-900 hover:bg-teal-100"
              >
                发起 OpenRouter PKCE 授权
              </button>
            )}
          </div>
          {onExchangeOpenRouterPkceCode && (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                data-testid="coach-pkce-code-input"
                value={pkceCodeDraft}
                onChange={(e) => setPkceCodeDraft(e.target.value)}
                placeholder="粘贴回调 code 换取会话 Key"
                className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-[11px]"
              />
              <button
                type="button"
                data-testid="coach-pkce-exchange-btn"
                disabled={!pkceCodeDraft.trim()}
                onClick={() => {
                  onExchangeOpenRouterPkceCode(pkceCodeDraft.trim());
                  setPkceCodeDraft("");
                }}
                className="rounded bg-slate-800 px-2 py-1 text-[11px] font-medium text-white disabled:opacity-40"
              >
                换取 Key
              </button>
            </div>
          )}
          {pkceStatus && <div className="text-[10px] text-teal-800">{pkceStatus}</div>}
        </div>
      )}

      <div>
        <label htmlFor="coach-cadence-select" className="block font-medium text-slate-900">
          AI 点评触发节奏（绝不每遍自动打扰）
        </label>
        <select
          id="coach-cadence-select"
          data-testid="coach-cadence-select"
          aria-label="AI 点评触发节奏"
          value={settings.cadence}
          onChange={(e) =>
            onChangeSettings({ ...settings, cadence: e.target.value as CoachCadence })
          }
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800"
        >
          <option value="on-demand">仅手动按需触发（点击按钮或按 G 键，默认推荐）</option>
          <option value="every-3-bouts">每满 3 个连贯回合自动汇总 1 次</option>
          <option value="end-of-session">仅会话总结时自动汇总 1 次</option>
        </select>
      </div>

      {settings.provider === "ollama" && (
        <div
          data-testid="coach-ollama-origins"
          className="space-y-1 rounded border border-amber-200 bg-amber-50/70 p-2 text-[11px] text-amber-950"
        >
          <div className="font-semibold">本地 Ollama 精确源配置向导（禁止使用 *）</div>
          <div className="rounded bg-white px-2 py-1 font-mono text-[10px] text-slate-800">
            {ollamaSetup.envVarLine}
          </div>
          <div className="font-mono text-[10px] text-slate-700">
            macOS: {ollamaSetup.macCommand}
          </div>
          <div>{ollamaSetup.warning}</div>
          {ollamaEnvNotice && (
            <div
              data-testid="coach-ollama-env-notice"
              className="rounded border border-amber-300 bg-white/80 px-2 py-1 text-[10px]"
            >
              <strong>{ollamaEnvNotice.title}：</strong>
              {ollamaEnvNotice.message}
            </div>
          )}
        </div>
      )}

      <div data-testid="coach-diagnostics-box" className="flex flex-wrap items-center justify-between gap-2 pt-1">
        {onTestConnection && (
          <button
            type="button"
            data-testid="coach-test-connection-btn"
            disabled={testingConnection}
            onClick={onTestConnection}
            className="rounded border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-60"
          >
            {testingConnection ? "正在检测连通性..." : "检测教练连通性与 CORS"}
          </button>
        )}
      </div>

      {diagnostic && (
        <div
          data-testid="coach-diagnostic-alert"
          className="rounded border border-rose-200 bg-rose-50 p-2 text-[11px] text-rose-950"
        >
          <div className="font-semibold">{diagnostic.title}</div>
          <p className="mt-0.5">{diagnostic.message}</p>
          {diagnostic.command && (
            <div className="mt-1 rounded bg-white px-2 py-1 font-mono text-[10px] text-slate-800">
              {diagnostic.command}
            </div>
          )}
          {diagnostic.hint && <p className="mt-1 text-[10px] text-rose-800">{diagnostic.hint}</p>}
        </div>
      )}
    </div>
  );
}
