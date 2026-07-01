import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type {
  AtifDocument, AtifStep, AtifToolCall, AtifObservation, AtifStepMetrics,
} from '../types';
import type { DagNode } from '../types/dag';
import { fetchAtifBySession, fetchAtifByConversation, triggerEval } from '../utils/apiClient';
import type { EvalReport } from '../utils/apiClient';
import { parseAtifToDag, groupNodesByStep } from '../utils/dagParser';
import { DagOverview, NODE_TYPE_STYLE } from '../components/DagOverview';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  return n.toLocaleString();
}

function fmtTimestamp(iso?: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function shortId(id: string, len = 20): string {
  return id.length > len ? id.slice(0, len) + '\u2026' : id;
}

// ─── Source styling ───────────────────────────────────────────────────────────

const SOURCE_STYLES: Record<string, { dot: string; badge: string; border: string; label: string }> = {
  system: {
    dot: 'bg-purple-500',
    badge: 'bg-purple-100 text-purple-700',
    border: 'border-l-purple-400',
    label: '系统',
  },
  user: {
    dot: 'bg-blue-500',
    badge: 'bg-blue-100 text-blue-700',
    border: 'border-l-blue-400',
    label: '用户',
  },
  agent: {
    dot: 'bg-green-500',
    badge: 'bg-green-100 text-green-700',
    border: 'border-l-green-400',
    label: 'Agent',
  },
};

function getSourceStyle(source: string) {
  return SOURCE_STYLES[source] ?? {
    dot: 'bg-gray-400',
    badge: 'bg-gray-100 text-gray-600',
    border: 'border-l-gray-300',
    label: source,
  };
}

// ─── Collapsible Section ──────────────────────────────────────────────────────

interface CollapsibleProps {
  icon: string;
  title: string;
  count?: number;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

const Collapsible: React.FC<CollapsibleProps> = ({ icon, title, count, isOpen, onToggle, children }) => (
  <div className="mt-3">
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between px-4 py-2 bg-gray-50 hover:bg-gray-100 rounded-lg text-left text-sm transition-colors"
    >
      <span className="flex items-center gap-2">
        <span>{icon}</span>
        <span className="font-medium text-gray-700">{title}</span>
        {count !== undefined && (
          <span className="px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded text-xs">{count}</span>
        )}
      </span>
      <span className="text-gray-400 text-xs">{isOpen ? '\u25b2' : '\u25bc'}</span>
    </button>
    {isOpen && <div className="mt-2 px-1">{children}</div>}
  </div>
);

// ─── ExpandableText ───────────────────────────────────────────────────────────

const TEXT_THRESHOLD = 300;

const ExpandableText: React.FC<{ text: string; className?: string }> = ({ text, className = '' }) => {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > TEXT_THRESHOLD;
  const display = isLong && !expanded ? text.slice(0, TEXT_THRESHOLD) + '\u2026' : text;

  return (
    <div>
      <pre className={`text-sm whitespace-pre-wrap break-words rounded-lg p-3 max-h-80 overflow-y-auto ${className}`}>
        {display}
      </pre>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-xs text-blue-600 hover:text-blue-800"
        >
          {expanded ? '← 收起' : '展开全部 →'}
        </button>
      )}
    </div>
  );
};

// ─── StepCard ─────────────────────────────────────────────────────────────────

interface StepCardProps {
  step: AtifStep;
  expandedSections: Set<string>;
  onToggleSection: (key: string) => void;
  dagNodes?: DagNode[];
}

const StepCard: React.FC<StepCardProps> = ({ step, expandedSections, onToggleSection, dagNodes }) => {
  const style = getSourceStyle(step.source);
  const sectionKey = (name: string) => `${step.step_id}-${name}`;
  const isOpen = (name: string) => expandedSections.has(sectionKey(name));
  const toggle = (name: string) => onToggleSection(sectionKey(name));

  const hasReasoning = !!step.reasoning_content;
  const hasToolCalls = !!step.tool_calls && step.tool_calls.length > 0;
  const hasObservation = !!step.observation && step.observation.results.length > 0;
  const hasMetrics = !!step.metrics && (
    step.metrics.prompt_tokens != null ||
    step.metrics.completion_tokens != null
  );

  return (
    <div className="relative pl-8 mb-4">
      {/* Timeline dot */}
      <div className={`absolute left-0 top-4 w-3 h-3 rounded-full ring-2 ring-white ${style.dot}`} />

      {/* Card */}
      <div className={`bg-white rounded-xl shadow-sm border border-gray-200 border-l-4 ${style.border} overflow-hidden`}>
        {/* Header */}
        <div className="px-5 py-3 flex items-center gap-3 flex-wrap">
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${style.badge}`}>
            {style.label}
          </span>
          <span className="text-sm font-medium text-gray-900">Step {step.step_id}</span>
          {step.timestamp && (
            <span className="text-xs text-gray-400">{fmtTimestamp(step.timestamp)}</span>
          )}
          {step.model_name && (
            <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full text-xs">
              {step.model_name}
            </span>
          )}
        </div>

        {/* DAG node-type badges */}
        {dagNodes && dagNodes.length > 0 && (
          <div className="px-5 pb-2 flex flex-wrap gap-1.5">
            {dagNodes.map((n) => {
              const ns = NODE_TYPE_STYLE[n.type];
              const suffix = n.unrolled_iter !== undefined ? ` #${n.unrolled_iter}` : '';
              const detail =
                n.type === 'TOOLSEL' || n.type === 'PARAMGEN' || n.type === 'EXEC'
                  ? `: ${n.label}`
                  : '';
              return (
                <span
                  key={n.id}
                  className={`text-[10px] px-1.5 py-0.5 border rounded ${ns.badge}`}
                  title={`${n.id}\n${n.preview || ''}`}
                >
                  {ns.label}{detail}{suffix}
                </span>
              );
            })}
          </div>
        )}

        {/* Body */}
        <div className="px-5 pb-4">
          {/* Message */}
          {step.message ? (
            <ExpandableText text={step.message} className="text-gray-700 bg-gray-50" />
          ) : (
            <span className="text-xs text-gray-400 italic">无消息内容</span>
          )}

          {/* Agent-only sections */}
          {step.source === 'agent' && (
            <>
              {/* Reasoning */}
              {hasReasoning && (
                <Collapsible
                  icon="💭"
                  title="推理过程"
                  isOpen={isOpen('reasoning')}
                  onToggle={() => toggle('reasoning')}
                >
                  <pre className="text-xs text-purple-700 whitespace-pre-wrap break-words bg-purple-50 rounded-lg p-3 border border-purple-100 max-h-64 overflow-y-auto">
                    {step.reasoning_content}
                  </pre>
                </Collapsible>
              )}

              {/* Tool Calls */}
              {hasToolCalls && (
                <Collapsible
                  icon="🔧"
                  title="工具调用"
                  count={step.tool_calls!.length}
                  isOpen={isOpen('toolcalls')}
                  onToggle={() => toggle('toolcalls')}
                >
                  <div className="space-y-2">
                    {step.tool_calls!.map((tc, i) => (
                      <ToolCallItem key={tc.tool_call_id || i} tc={tc} />
                    ))}
                  </div>
                </Collapsible>
              )}

              {/* Observation */}
              {hasObservation && (
                <Collapsible
                  icon="📋"
                  title="观察结果"
                  count={step.observation!.results.length}
                  isOpen={isOpen('observation')}
                  onToggle={() => toggle('observation')}
                >
                  <div className="space-y-2">
                    {step.observation!.results.map((r, i) => (
                      <div key={i} className="border border-teal-100 rounded-lg overflow-hidden">
                        {r.source_call_id && (
                          <div className="px-3 py-1 bg-teal-50 border-b border-teal-100">
                            <span className="text-xs text-gray-400 font-mono">call: {shortId(r.source_call_id, 16)}</span>
                          </div>
                        )}
                        {r.content ? (
                          <div className="p-2">
                            <ExpandableText text={r.content} className="text-xs text-gray-700 bg-teal-50 font-mono" />
                          </div>
                        ) : (
                          <div className="px-3 py-2 text-xs text-gray-400 italic">无输出内容</div>
                        )}
                      </div>
                    ))}
                  </div>
                </Collapsible>
              )}

              {/* Metrics */}
              {hasMetrics && (
                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-gray-100">
                  {step.metrics!.prompt_tokens != null && (
                    <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded text-xs">
                      输入: {fmtTokens(step.metrics!.prompt_tokens!)}
                    </span>
                  )}
                  {step.metrics!.completion_tokens != null && (
                    <span className="px-2 py-1 bg-green-50 text-green-700 rounded text-xs">
                      输出: {fmtTokens(step.metrics!.completion_tokens!)}
                    </span>
                  )}
                  {step.metrics!.cached_tokens != null && step.metrics!.cached_tokens! > 0 && (
                    <span className="px-2 py-1 bg-yellow-50 text-yellow-700 rounded text-xs">
                      缓存: {fmtTokens(step.metrics!.cached_tokens!)}
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── ToolCallItem ─────────────────────────────────────────────────────────────

const ToolCallItem: React.FC<{ tc: AtifToolCall }> = ({ tc }) => {
  const [showArgs, setShowArgs] = useState(false);
  const argsStr = typeof tc.arguments === 'string'
    ? tc.arguments
    : JSON.stringify(tc.arguments, null, 2);
  const isLongArgs = argsStr.length > 200;

  return (
    <div className="border border-orange-100 rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-orange-50 flex items-center gap-2 flex-wrap">
        <span className="px-2 py-0.5 bg-orange-100 text-orange-700 rounded text-xs font-mono font-medium">
          {tc.function_name}
        </span>
        <span className="text-xs text-gray-400 font-mono">{shortId(tc.tool_call_id, 16)}</span>
        {isLongArgs && (
          <button
            onClick={() => setShowArgs(!showArgs)}
            className="ml-auto text-xs text-blue-600 hover:text-blue-800"
          >
            {showArgs ? '收起参数' : '展开参数'}
          </button>
        )}
      </div>
      {(!isLongArgs || showArgs) && (
        <pre className="text-xs text-gray-700 whitespace-pre-wrap break-words bg-white p-3 max-h-48 overflow-y-auto font-mono">
          {argsStr}
        </pre>
      )}
    </div>
  );
};

// ─── AgentInfoCard ────────────────────────────────────────────────────────────

const AgentInfoCard: React.FC<{ doc: AtifDocument }> = ({ doc }) => {
  const { agent } = doc;
  const toolCount = agent.tool_definitions?.length ?? 0;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 lg:col-span-2">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">Agent 信息</h3>
      <div className="space-y-2 text-sm">
        {[
          { label: '名称', value: agent.name },
          { label: '版本', value: agent.version },
          { label: '模型', value: agent.model_name ?? '—' },
          { label: '工具定义', value: `${toolCount} 个` },
        ].map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between">
            <span className="text-gray-500">{label}</span>
            <span className="text-gray-900 font-medium font-mono">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── MetricCard ───────────────────────────────────────────────────────────────

const MetricCard: React.FC<{ label: string; value: string; color: string; sub?: string }> = ({ label, value, color, sub }) => (
  <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 flex flex-col justify-center">
    <span className="text-sm text-gray-500 mb-1">{label}</span>
    <span className={`text-2xl font-bold ${color}`}>{value}</span>
    {sub && <span className="text-xs text-gray-400 mt-1">{sub}</span>}
  </div>
);

// ─── Main Page ────────────────────────────────────────────────────────────────

export const AtifViewerPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Input state
  const [queryType, setQueryType] = useState<'session' | 'conversation'>(
    (searchParams.get('type') as 'session' | 'conversation') || 'session'
  );
  const [queryId, setQueryId] = useState(searchParams.get('id') || '');

  // Data state
  const [doc, setDoc] = useState<AtifDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Evaluation state
  const [evalReport, setEvalReport] = useState<EvalReport | null>(null);
  const [evalLoading, setEvalLoading] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);

  const handleRunEval = useCallback(async () => {
    if (!doc) return;
    setEvalLoading(true);
    setEvalError(null);
    try {
      const report = await triggerEval(doc.session_id);
      setEvalReport(report);
    } catch (e: any) {
      setEvalError(e.message ?? '评估失败');
    } finally {
      setEvalLoading(false);
    }
  }, [doc]);

  const toggleSection = useCallback((key: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Load data
  const handleLoad = useCallback(async (type?: 'session' | 'conversation', id?: string) => {
    const t = type ?? queryType;
    const i = id ?? queryId;
    if (!i.trim()) return;

    setSearchParams({ type: t, id: i.trim() }, { replace: true });
    setLoading(true);
    setError(null);
    setDoc(null);
    setExpandedSections(new Set());

    try {
      let data: AtifDocument;
      if (t === 'conversation') {
        data = await fetchAtifByConversation(i.trim());
      } else {
        data = await fetchAtifBySession(i.trim());
      }
      setDoc(data);
    } catch (e: any) {
      setError(e.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  }, [queryType, queryId, setSearchParams]);

  // Auto-load from URL on mount
  useEffect(() => {
    const urlType = searchParams.get('type') as 'session' | 'conversation' | null;
    const urlId = searchParams.get('id');
    if (urlType && urlId) {
      setQueryType(urlType);
      setQueryId(urlId);
      handleLoad(urlType, urlId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // JSON file import
  const handleFileImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        if (!parsed.schema_version || !String(parsed.schema_version).startsWith('ATIF')) {
          setError('JSON 解析失败：缺少 schema_version 字段或非 ATIF 格式');
          return;
        }
        setDoc(parsed as AtifDocument);
        setError(null);
        setQueryId(parsed.session_id ?? '');
      } catch {
        setError('JSON 解析失败，请检查文件格式');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, []);

  // JSON download
  const handleDownload = useCallback(() => {
    if (!doc) return;
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `atif-${doc.session_id.slice(0, 16)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [doc]);

  // Compute DAG and group nodes by step (memoized).
  const dag = useMemo(() => (doc ? parseAtifToDag(doc) : null), [doc]);
  const dagNodesByStep = useMemo(
    () => (dag ? groupNodesByStep(dag) : new Map<number, DagNode[]>()),
    [dag],
  );

  // Compute metrics (fallback when final_metrics is partial)
  const computedMetrics = doc ? (() => {
    const fm = doc.final_metrics;
    let promptSum = 0, completionSum = 0, cachedSum = 0;
    for (const s of doc.steps) {
      if (s.metrics) {
        promptSum += s.metrics.prompt_tokens ?? 0;
        completionSum += s.metrics.completion_tokens ?? 0;
        cachedSum += s.metrics.cached_tokens ?? 0;
      }
    }
    return {
      steps: fm?.total_steps ?? doc.steps.length,
      prompt: fm?.total_prompt_tokens ?? promptSum,
      completion: fm?.total_completion_tokens ?? completionSum,
      cached: fm?.total_cached_tokens ?? cachedSum,
    };
  })() : null;

  return (
    <>
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-screen-xl mx-auto flex items-center gap-4">
          <button
            onClick={() => navigate(-1)}
            className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm transition-colors"
            title="返回上一页"
          >
            ← 返回
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-gray-900">ATIF 轨迹查看器</h1>
            {doc && (
              <div className="flex items-center gap-2 mt-0.5">
                <span className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">
                  {doc.schema_version}
                </span>
                <span className="text-xs text-gray-400 font-mono truncate">{doc.session_id}</span>
              </div>
            )}
          </div>
          {doc && (
            <button onClick={handleDownload}
              className="flex-shrink-0 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm transition-colors">
              ⬇️ 下载 JSON
            </button>
          )}
        </div>
      </header>

      <main className="max-w-screen-xl mx-auto px-6 py-6 space-y-6">
        {/* Input Controls */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 flex flex-wrap items-end gap-4">
          {/* Type toggle */}
          <div className="flex gap-1">
            {(['session', 'conversation'] as const).map(t => (
              <button
                key={t}
                onClick={() => setQueryType(t)}
                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                  queryType === t
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                按 {t === 'conversation' ? 'Conversation' : 'Session'}
              </button>
            ))}
          </div>

          {/* ID input */}
          <div className="flex-1 min-w-[240px]">
            <input
              type="text"
              value={queryId}
              onChange={e => setQueryId(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleLoad(); }}
              placeholder={queryType === 'conversation' ? '输入 Conversation ID...' : '输入 Session ID...'}
              className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>

          {/* Load button */}
          <button
            onClick={() => handleLoad()}
            disabled={loading || !queryId.trim()}
            className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? '加载中...' : '加载'}
          </button>

          {/* File import */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileImport}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm rounded-lg transition-colors"
          >
            📁 导入 JSON
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-600 text-sm">
            ⚠️ {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-16">
            <div className="text-center">
              <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-4" />
              <p className="text-gray-600">加载中...</p>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!loading && !doc && !error && (
          <div className="flex items-center justify-center py-24">
            <div className="text-center">
              <p className="text-3xl text-gray-300 mb-4">ATIF</p>
              <p className="text-gray-500">请输入 Session 或 Conversation ID，然后点击「加载」</p>
              <p className="text-gray-400 text-sm mt-1">或导入本地 ATIF JSON 文件</p>
            </div>
          </div>
        )}

        {/* Loaded content */}
        {doc && !loading && (
          <>
            {/* Agent info + Metrics */}
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
              <AgentInfoCard doc={doc} />
              {computedMetrics && (
                <>
                  <MetricCard
                    label="总步骤数"
                    value={String(computedMetrics.steps)}
                    color="text-indigo-600"
                  />
                  <MetricCard
                    label="总输入 Token"
                    value={fmtTokens(computedMetrics.prompt)}
                    color="text-blue-600"
                    sub={computedMetrics.cached > 0 ? `其中缓存: ${fmtTokens(computedMetrics.cached)}` : undefined}
                  />
                  <MetricCard
                    label="总输出 Token"
                    value={fmtTokens(computedMetrics.completion)}
                    color="text-green-600"
                  />
                </>
              )}
            </div>

            {/* DAG Overview */}
            {dag && <DagOverview dag={dag} evalReport={evalReport} />}

            {/* Evaluation Control */}
            {doc && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h3 className="text-sm font-semibold text-gray-900">DAG 评估</h3>
                    {evalReport && evalReport.summary && (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="px-2 py-0.5 bg-gray-100 rounded">
                          均分 {evalReport.summary.avg_score.toFixed(2)}/5
                        </span>
                        <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded">
                          {evalReport.summary.failure_count} 失败
                        </span>
                        <span className="px-2 py-0.5 bg-orange-100 text-orange-700 rounded">
                          {evalReport.summary.root_cause_count} 根因
                        </span>
                      </div>
                    )}
                  </div>
                  <button
                    onClick={handleRunEval}
                    disabled={evalLoading}
                    className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {evalLoading ? '评估中...(约5-10分钟)' : '运行评估'}
                  </button>
                </div>
                {evalError && (
                  <div className="mt-2 text-xs text-red-600 bg-red-50 p-2 rounded">{evalError}</div>
                )}
              </div>
            )}

            {/* Step Timeline + Eval Panel (two-column layout) */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
              {/* Left: Step Timeline */}
              <div>
                <h2 className="text-lg font-semibold text-gray-900 mb-4">
                  交互轨迹
                  <span className="ml-2 text-sm font-normal text-gray-400">
                    共 {doc.steps.length} 步
                  </span>
                </h2>

                {doc.steps.length === 0 ? (
                  <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
                    <p className="text-4xl text-gray-300 mb-2">--</p>
                    <p className="text-gray-400">该轨迹暂无步骤数据</p>
                  </div>
                ) : (
                  <div className="relative pl-4">
                    {/* Vertical line */}
                    <div className="absolute left-[5px] top-4 bottom-4 w-0.5 bg-gray-200" />

                    {doc.steps.map(step => (
                      <StepCard
                        key={step.step_id}
                        step={step}
                        expandedSections={expandedSections}
                        onToggleSection={toggleSection}
                        dagNodes={dagNodesByStep.get(step.step_id)}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Right: Eval Score Panel (grouped by step) */}
              {evalReport && evalReport.nodes.length > 0 && (
                <div className="hidden lg:block">
                  <div className="sticky top-4">
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">节点评分</h3>
                    {/* Tag meaning legend */}
                    <div className="mb-3 p-2 bg-gray-50 rounded-lg text-[10px] text-gray-600 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded font-medium">根因</span>
                        <span>= 失败的源头节点（无上游失败）</span>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded font-medium">传播</span>
                        <span>= 失败由上游传播而来（非自身问题）</span>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="px-1.5 py-0.5 bg-orange-50 text-orange-700 rounded border border-orange-200">橙色标签</span>
                        <span>= 失败分类（3级21类 Taxonomy）</span>
                      </div>
                    </div>
                    <div className="max-h-[calc(100vh-180px)] overflow-y-auto space-y-3 pr-1">
                      {/* Group nodes by step_id */}
                      {(() => {
                        const grouped = new Map<number, typeof evalReport.nodes>();
                        for (const en of evalReport.nodes) {
                          const stepId = Number(en.node_id.match(/^s(\d+)\./)?.[1] ?? 0);
                          const arr = grouped.get(stepId) ?? [];
                          arr.push(en);
                          grouped.set(stepId, arr);
                        }
                        return Array.from(grouped.entries()).map(([stepId, nodes]) => {
                          const avgScore = nodes.reduce((s, n) => s + n.score, 0) / nodes.length;
                          const hasFailure = nodes.some(n => n.is_failure);
                          const cardBorder = hasFailure ? 'border-red-300' : avgScore >= 4 ? 'border-green-300' : 'border-gray-200';
                          return (
                            <div key={stepId} className={`bg-white rounded-lg border ${cardBorder} overflow-hidden`}>
                              {/* Step header */}
                              <div className={`px-3 py-2 flex items-center justify-between ${hasFailure ? 'bg-red-50' : 'bg-gray-50'} border-b border-gray-100`}>
                                <span className="text-xs font-semibold text-gray-700">Step {stepId}</span>
                                <span className={`text-xs font-bold ${avgScore >= 4 ? 'text-green-700' : avgScore >= 3 ? 'text-yellow-700' : 'text-red-700'}`}>
                                  {avgScore.toFixed(1)}/5
                                </span>
                              </div>
                              {/* Nodes in this step */}
                              <div className="divide-y divide-gray-50">
                                {nodes.map((en) => {
                                  const attrType = en.attribution?.type ?? 'Pass';
                                  const scoreClass = en.score >= 4 ? 'text-green-700' : en.score === 3 ? 'text-yellow-700' : 'text-red-700';
                                  return (
                                    <div key={en.node_id} className="px-3 py-2">
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                          <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 rounded shrink-0">{en.node_type}</span>
                                          <span className="text-[11px] font-mono text-gray-500 truncate" title={en.node_id}>
                                            {en.node_id.replace(/^s\d+\./, '')}
                                          </span>
                                        </div>
                                        <span className={`text-sm font-bold shrink-0 ${scoreClass}`}>{en.score}</span>
                                      </div>
                                      {en.is_failure && (
                                        <div className="mt-1.5 space-y-1">
                                          <div className="flex items-center gap-1 flex-wrap">
                                            <span className="text-[10px] px-1.5 py-0.5 bg-red-100 text-red-700 rounded font-medium">
                                              {attrType === 'RootCause' ? '根因' : '传播'}
                                            </span>
                                            {en.failure_class && (
                                              <span className="text-[10px] px-1.5 py-0.5 bg-orange-50 text-orange-700 rounded border border-orange-200">
                                                {en.failure_class.level1} / {en.failure_class.level2} / {en.failure_class.level3}
                                              </span>
                                            )}
                                          </div>
                                          {en.reasoning && (
                                            <details className="group" open>
                                              <summary className="text-[10px] text-blue-600 cursor-pointer hover:text-blue-800">展开 Judge 推理</summary>
                                              <pre className="mt-1 text-[10px] text-gray-600 whitespace-pre-wrap break-words bg-gray-50 rounded p-2 max-h-48 overflow-y-auto">
                                                {en.reasoning}
                                              </pre>
                                            </details>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        });
                      })()}

                      {/* Taxonomy legend */}
                      <details className="mt-4">
                        <summary className="text-[11px] text-gray-500 cursor-pointer hover:text-gray-700 font-medium">
                          失败分类说明 (Taxonomy)
                        </summary>
                        <div className="mt-2 text-[10px] text-gray-600 bg-gray-50 rounded-lg p-3 space-y-2">
                          <div>
                            <span className="font-semibold text-gray-800">Planning（规划层）</span>
                            <ul className="ml-3 mt-0.5 space-y-0.5 list-disc list-inside">
                              <li><b>Goal misinterpretation</b> — 目标理解偏差（Scope error / Ambiguity failure）</li>
                              <li><b>Missing steps</b> — 遗漏关键步骤（Tool omission / Verification gap / Prerequisite skip）</li>
                              <li><b>Incorrect ordering</b> — 执行顺序错误（Dependency violation / Suboptimal sequence）</li>
                            </ul>
                          </div>
                          <div>
                            <span className="font-semibold text-gray-800">Execution（执行层）</span>
                            <ul className="ml-3 mt-0.5 space-y-0.5 list-disc list-inside">
                              <li><b>Wrong tool selection</b> — 工具选错（Category error / Granularity mismatch）</li>
                              <li><b>Parameter errors</b> — 参数错误（Type mismatch / Value error / Missing required）</li>
                              <li><b>API/tool failures</b> — 工具执行失败（Timeout / Error response）</li>
                            </ul>
                          </div>
                          <div>
                            <span className="font-semibold text-gray-800">Integration（整合层）</span>
                            <ul className="ml-3 mt-0.5 space-y-0.5 list-disc list-inside">
                              <li><b>Context loss</b> — 上下文丢失（Truncation / Selective omission）</li>
                              <li><b>Output hallucination</b> — 输出幻觉（Fabrication / Conflation）</li>
                              <li><b>Premature termination</b> — 过早结束（Partial completion / Loop exit）</li>
                            </ul>
                          </div>
                        </div>
                      </details>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </>
  );
};
