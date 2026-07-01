import React, { useMemo, useRef, useState } from 'react';
import type { EvalReport, EvalNodeResult } from '../utils/apiClient';
import type { DagDiagnostic, DagNode, DagNodeType, EvalDag, WarnLevel } from '../types/dag';

// ─── Node-type styling (shared with StepCard badges) ─────────────────────────

export const NODE_TYPE_STYLE: Record<
  DagNodeType,
  { fill: string; stroke: string; text: string; badge: string; label: string }
> = {
  SYSTEM: {
    fill: '#f3e8ff',
    stroke: '#9333ea',
    text: '#6b21a8',
    badge: 'bg-purple-100 text-purple-700 border-purple-200',
    label: 'System',
  },
  USER_QUERY: {
    fill: '#dbeafe',
    stroke: '#2563eb',
    text: '#1e40af',
    badge: 'bg-blue-100 text-blue-700 border-blue-200',
    label: 'User',
  },
  PLAN: {
    fill: '#e0e7ff',
    stroke: '#4f46e5',
    text: '#3730a3',
    badge: 'bg-indigo-100 text-indigo-700 border-indigo-200',
    label: 'Plan',
  },
  TOOLSEL: {
    fill: '#ffedd5',
    stroke: '#ea580c',
    text: '#9a3412',
    badge: 'bg-orange-100 text-orange-700 border-orange-200',
    label: 'ToolSel',
  },
  PARAMGEN: {
    fill: '#fef3c7',
    stroke: '#d97706',
    text: '#92400e',
    badge: 'bg-yellow-100 text-yellow-700 border-yellow-200',
    label: 'ParamGen',
  },
  EXEC: {
    fill: '#cffafe',
    stroke: '#0891b2',
    text: '#155e75',
    badge: 'bg-cyan-100 text-cyan-700 border-cyan-200',
    label: 'Exec',
  },
  SYNTH: {
    fill: '#dcfce7',
    stroke: '#16a34a',
    text: '#166534',
    badge: 'bg-green-100 text-green-700 border-green-200',
    label: 'Synth',
  },
};

export function getNodeTypeStyle(type: DagNodeType) {
  return NODE_TYPE_STYLE[type];
}

// ─── Layout (column = step_id, row = node-type rank within step) ─────────────

const TYPE_ROW: Record<DagNodeType, number> = {
  SYSTEM: 0,
  USER_QUERY: 0,
  PLAN: 1,
  TOOLSEL: 2,
  PARAMGEN: 3,
  EXEC: 4,
  SYNTH: 5,
};

const COL_WIDTH = 180;
const ROW_HEIGHT = 108;
const NODE_W = 160;
const NODE_H = 90;
const PAD_X = 24;
const PAD_Y = 24;

interface Pos {
  x: number;
  y: number;
}

function layoutNodes(dag: EvalDag): { positions: Map<string, Pos>; width: number; height: number } {
  // 1. Group nodes by step_id and bucket by type-row, ties broken by parse order.
  const positions = new Map<string, Pos>();
  const stepOrder: number[] = [];
  const stepBuckets = new Map<number, Map<number, DagNode[]>>(); // step → row → nodes

  for (const n of dag.nodes) {
    if (!stepBuckets.has(n.step_id)) {
      stepBuckets.set(n.step_id, new Map());
      stepOrder.push(n.step_id);
    }
    const rows = stepBuckets.get(n.step_id)!;
    const r = TYPE_ROW[n.type];
    const arr = rows.get(r) ?? [];
    arr.push(n);
    rows.set(r, arr);
  }

  // 2. Assign columns. Each step gets one column; if a row has multiple nodes
  //    (parallel tools / unrolled retries), they stack as sub-columns within.
  let curX = PAD_X;
  for (const stepId of stepOrder) {
    const rows = stepBuckets.get(stepId)!;
    const maxParallel = Math.max(1, ...Array.from(rows.values()).map((arr) => arr.length));
    const stepColW = COL_WIDTH + (maxParallel - 1) * (NODE_W + 12);
    for (const [row, arr] of rows) {
      arr.forEach((node, i) => {
        positions.set(node.id, {
          x: curX + i * (NODE_W + 12),
          y: PAD_Y + row * ROW_HEIGHT,
        });
      });
    }
    curX += stepColW;
  }

  const maxRow = Math.max(0, ...dag.nodes.map((n) => TYPE_ROW[n.type]));
  const width = curX + PAD_X;
  const height = PAD_Y * 2 + (maxRow + 1) * ROW_HEIGHT;
  return { positions, width, height };
}

// ─── Edge styling ────────────────────────────────────────────────────────────

function edgeStyle(kind: string): { stroke: string; dash?: string; width: number } {
  switch (kind) {
    case 'intra_step':
      return { stroke: '#475569', width: 1.5 };
    case 'inter_step':
      return { stroke: '#94a3b8', dash: '4 4', width: 1.5 };
    case 'tool_link':
      return { stroke: '#0891b2', width: 2.5 };
    case 'fallback_seq':
      return { stroke: '#cbd5e1', width: 1 };
    default:
      return { stroke: '#94a3b8', width: 1 };
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

interface DagOverviewProps {
  evalReport?: EvalReport | null;
  dag: EvalDag;
  /** Optional: id of the node to highlight (e.g. when a StepCard badge is hovered). */
  highlightId?: string | null;
}

export const DagOverview: React.FC<DagOverviewProps> = ({ dag, highlightId, evalReport }) => {
  const [collapsed, setCollapsed] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [diagOpen, setDiagOpen] = useState(false);
  const svgScrollRef = useRef<HTMLDivElement | null>(null);

  const layout = useMemo(() => layoutNodes(dag), [dag]);

  const nodeById = useMemo(() => {
    const m = new Map<string, DagNode>();
    for (const n of dag.nodes) m.set(n.id, n);
    return m;
  }, [dag]);

  const activeId = hoverId ?? highlightId ?? null;

  /** Jump to a node: highlight it and horizontally scroll into view. */
  const focusNode = (nodeId: string | undefined) => {
    if (!nodeId) return;
    setHoverId(nodeId);
    const pos = layout.positions.get(nodeId);
    const container = svgScrollRef.current;
    if (pos && container) {
      // Center the node in the visible scroll area.
      const target = Math.max(0, pos.x - container.clientWidth / 2 + NODE_W / 2);
      container.scrollTo({ left: target, behavior: 'smooth' });
    }
  };

  if (dag.nodes.length === 0) {
    return null;
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full px-5 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-900">DAG 结构</h3>
          <span className="text-xs text-gray-500">
            节点 {dag.nodes.length} 个 · 边 {dag.edges.length} 条
            {dag.fallback !== 'none' && (
              <span className="ml-2 px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded">
                fallback: {dag.fallback}
              </span>
            )}
          </span>
          {/* Severity badges (replaces single yellow tooltip badge). */}
          {dag.diagnostics.length > 0 && (() => {
            const errN = dag.diagnostics.filter((d) => d.level === 'error').length;
            const warnN = dag.diagnostics.filter((d) => d.level === 'warn').length;
            const infoN = dag.diagnostics.filter((d) => d.level === 'info').length;
            return (
              <span className="text-xs inline-flex items-center gap-1">
                {errN > 0 && (
                  <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded">
                    {errN} 错误
                  </span>
                )}
                {warnN > 0 && (
                  <span className="px-1.5 py-0.5 bg-yellow-100 text-yellow-700 rounded">
                    {warnN} 警告
                  </span>
                )}
                {infoN > 0 && (
                  <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">
                    {infoN} 提示
                  </span>
                )}
              </span>
            );
          })()}
        </div>
        <span className="text-gray-400 text-xs">{collapsed ? '\u25bc' : '\u25b2'}</span>
      </button>

      {!collapsed && (
        <div className="border-t border-gray-100">
          {/* Legend: node types + edge kinds */}
          <div className="px-5 py-2 flex flex-wrap items-center gap-x-4 gap-y-2 bg-gray-50 border-b border-gray-100">
            {/* Node-type pills */}
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] uppercase tracking-wide text-gray-400 mr-1">
                节点
              </span>
              {(Object.keys(NODE_TYPE_STYLE) as DagNodeType[]).map((t) => {
                const s = NODE_TYPE_STYLE[t];
                return (
                  <span
                    key={t}
                    className={`text-xs px-2 py-0.5 border rounded-full ${s.badge}`}
                  >
                    {s.label}
                  </span>
                );
              })}
            </div>

            {/* Vertical divider */}
            <span className="hidden sm:inline-block h-5 w-px bg-gray-300" />

            {/* Edge-kind legend */}
            <div className="flex flex-wrap gap-3 items-center">
              <span className="text-[10px] uppercase tracking-wide text-gray-400">
                边
              </span>
              {[
                { kind: 'intra_step', label: 'step 内主链' },
                { kind: 'inter_step', label: '跨 step' },
                { kind: 'tool_link', label: 'tool_call 绑定' },
                { kind: 'fallback_seq', label: '兜底顺序' },
              ].map(({ kind, label }) => {
                const s = edgeStyle(kind);
                return (
                  <span
                    key={kind}
                    className="inline-flex items-center gap-1 text-xs text-gray-600"
                    title={`edge.kind = ${kind}`}
                  >
                    <svg width="28" height="10" viewBox="0 0 28 10">
                      <line
                        x1="0"
                        y1="5"
                        x2="24"
                        y2="5"
                        stroke={s.stroke}
                        strokeWidth={s.width}
                        strokeDasharray={s.dash}
                      />
                      <polygon points="24,2 28,5 24,8" fill={s.stroke} />
                    </svg>
                    {label}
                  </span>
                );
              })}
            </div>
          </div>

            {/* Eval score border legend (only visible when evalReport is loaded) */}
            {evalReport && evalReport.nodes.length > 0 && (
              <>
                <span className="hidden sm:inline-block h-5 w-px bg-gray-300" />
                <div className="flex flex-wrap gap-3 items-center">
                  <span className="text-[10px] uppercase tracking-wide text-gray-400">
                    评分
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs text-gray-600">
                    <span className="w-4 h-4 rounded border-2 border-green-600 bg-green-50" />
                    4-5 通过
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs text-gray-600">
                    <span className="w-4 h-4 rounded border-2 border-yellow-600 bg-yellow-50" />
                    3 临界
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs text-gray-600">
                    <span className="w-4 h-4 rounded border-[3px] border-red-600 bg-red-50" />
                    1-2 失败
                  </span>
                </div>
              </>
            )}

          {/* Diagnostics triage panel */}
          {dag.diagnostics.length > 0 && (
            <DagDiagnosticsPanel
              diagnostics={dag.diagnostics}
              open={diagOpen}
              onToggle={() => setDiagOpen((v) => !v)}
              onSelect={focusNode}
              activeId={activeId}
            />
          )}

          {/* SVG canvas */}
          <div className="overflow-x-auto" style={{ maxHeight: 360 }} ref={svgScrollRef}>
            <svg
              width={layout.width}
              height={layout.height}
              style={{ display: 'block', minWidth: '100%' }}
            >
              <defs>
                <marker
                  id="dag-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" />
                </marker>
                <marker
                  id="dag-arrow-light"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
                </marker>
                <marker
                  id="dag-arrow-tool"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#0891b2" />
                </marker>
              </defs>

              {/* Edges first so nodes overlay them. */}
              {dag.edges.map((e, i) => {
                const a = layout.positions.get(e.from);
                const b = layout.positions.get(e.to);
                if (!a || !b) return null;
                const sx = a.x + NODE_W / 2;
                const sy = a.y + NODE_H;
                const tx = b.x + NODE_W / 2;
                const ty = b.y;
                const style = edgeStyle(e.kind);
                const markerId =
                  e.kind === 'tool_link'
                    ? 'dag-arrow-tool'
                    : e.kind === 'inter_step' || e.kind === 'fallback_seq'
                      ? 'dag-arrow-light'
                      : 'dag-arrow';
                // Quadratic curve for visual clarity when nodes are far apart.
                const dx = tx - sx;
                const dy = ty - sy;
                const cx = sx + dx / 2;
                const cy = sy + dy / 2 + Math.min(20, Math.abs(dx) / 6);
                const path = `M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}`;
                return (
                  <path
                    key={i}
                    d={path}
                    fill="none"
                    stroke={style.stroke}
                    strokeWidth={style.width}
                    strokeDasharray={style.dash}
                    markerEnd={`url(#${markerId})`}
                  />
                );
              })}

              {/* Nodes */}
              {dag.nodes.map((n) => {
                const p = layout.positions.get(n.id);
                if (!p) return null;
                const style = NODE_TYPE_STYLE[n.type];
                const active = activeId === n.id;
                // Eval score overlay: color-code the node border by score
                const evalNode = evalReport?.nodes?.find((en: EvalNodeResult) => en.node_id === n.id);
                const evalScore = evalNode?.score;
                const evalStroke = evalScore !== undefined
                  ? evalScore >= 4 ? "#16a34a" : evalScore === 3 ? "#d97706" : "#dc2626"
                  : undefined;
                const evalBorderWidth = evalNode?.is_failure ? 3 : (evalScore !== undefined ? 2 : undefined);
                return (
                  <g
                    key={n.id}
                    transform={`translate(${p.x}, ${p.y})`}
                    onMouseEnter={() => setHoverId(n.id)}
                    onMouseLeave={() => setHoverId(null)}
                    style={{ cursor: 'default' }}
                  >
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      rx={6}
                      ry={6}
                      fill={style.fill}
                      stroke={active ? '#0f172a' : (evalStroke ?? style.stroke)}
                      strokeWidth={active ? 2 : (evalBorderWidth ?? 1)}
                    />
                    <text
                      x={8}
                      y={14}
                      fontSize={9}
                      fontWeight={600}
                      fill={style.text}
                      style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}
                    >
                      {n.type}
                      {n.unrolled_iter !== undefined ? ` #${n.unrolled_iter}` : ''}
                    </text>
                    <text x={8} y={28} fontSize={11} fontWeight={600} fill="#0f172a">
                      {(() => {
                        const lbl = n.label ?? '';
                        return lbl.length > 22 ? lbl.slice(0, 21) + '\u2026' : lbl;
                      })()}
                    </text>
                    {/* Inline preview via foreignObject so it auto-wraps + clamps. */}
                    {n.preview && (
                      <foreignObject x={8} y={34} width={NODE_W - 16} height={NODE_H - 38}>
                        <div
                          style={{
                            fontSize: 10,
                            lineHeight: '13px',
                            color: '#334155',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            wordBreak: 'break-all',
                            whiteSpace: 'normal',
                            overflow: 'hidden',
                            display: '-webkit-box',
                            WebkitLineClamp: 4,
                            WebkitBoxOrient: 'vertical' as any,
                          }}
                        >
                          {n.preview}
                        </div>
                      </foreignObject>
                    )}
                    <title>
                      {`${n.type} · step ${n.step_id}\n${n.preview || '(no preview)'}`}
                    </title>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Hover preview footer: shows the FULL preview content with wrapping + scroll. */}
          {activeId && nodeById.get(activeId) && (
            <div className="px-5 py-2 text-xs text-gray-700 border-t border-gray-100 bg-gray-50">
              <div className="font-mono text-gray-400 mb-1">
                {nodeById.get(activeId)!.type} · step {nodeById.get(activeId)!.step_id} · {activeId}
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed max-h-40 overflow-y-auto bg-white rounded p-2 border border-gray-200">
                {nodeById.get(activeId)!.preview || '无内容'}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Diagnostics Triage Panel ──────────────────────────────────────

const LEVEL_META: Record<
  WarnLevel,
  { order: number; label: string; pillClass: string; icon: string; rowClass: string }
> = {
  error: {
    order: 0,
    label: '错误',
    pillClass: 'bg-red-100 text-red-700 border-red-200',
    icon: '✖',
    rowClass: 'hover:bg-red-50',
  },
  warn: {
    order: 1,
    label: '警告',
    pillClass: 'bg-yellow-100 text-yellow-700 border-yellow-200',
    icon: '⚠',
    rowClass: 'hover:bg-yellow-50',
  },
  info: {
    order: 2,
    label: '提示',
    pillClass: 'bg-blue-100 text-blue-700 border-blue-200',
    icon: 'ℹ',
    rowClass: 'hover:bg-blue-50',
  },
};

interface DagDiagnosticsPanelProps {
  diagnostics: DagDiagnostic[];
  open: boolean;
  onToggle: () => void;
  onSelect: (nodeId: string | undefined) => void;
  activeId: string | null;
}

const DagDiagnosticsPanel: React.FC<DagDiagnosticsPanelProps> = ({
  diagnostics,
  open,
  onToggle,
  onSelect,
  activeId,
}) => {
  // Group by level, ordered ERROR → WARN → INFO.
  const grouped = useMemo(() => {
    const buckets: Record<WarnLevel, DagDiagnostic[]> = { error: [], warn: [], info: [] };
    for (const d of diagnostics) buckets[d.level].push(d);
    return buckets;
  }, [diagnostics]);

  const total = diagnostics.length;

  return (
    <div className="border-b border-gray-100">
      <button
        onClick={onToggle}
        className="w-full px-5 py-2 flex items-center justify-between text-xs hover:bg-gray-50 transition-colors"
      >
        <span className="flex items-center gap-2 text-gray-700">
          <span className="text-gray-400">{open ? '\u25be' : '\u25b8'}</span>
          <span className="font-medium">诊断详情</span>
          <span className="text-gray-400">({total})</span>
        </span>
      </button>

      {open && (
        <div className="px-5 pb-3 space-y-2 bg-gray-50">
          {(['error', 'warn', 'info'] as WarnLevel[]).map((lv) => {
            const items = grouped[lv];
            const meta = LEVEL_META[lv];
            return (
              <div key={lv}>
                <div className="flex items-center gap-2 mt-2 mb-1">
                  <span
                    className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 border rounded ${meta.pillClass}`}
                  >
                    {meta.label} ({items.length})
                  </span>
                </div>
                {items.length === 0 ? (
                  <div className="pl-4 text-[11px] text-gray-400 italic">无</div>
                ) : (
                  <ul className="space-y-0.5">
                    {items.map((d, idx) => {
                      const clickable = !!d.node_id;
                      const active = d.node_id && d.node_id === activeId;
                      return (
                        <li key={`${lv}-${idx}`}>
                          <button
                            type="button"
                            disabled={!clickable}
                            onClick={() => clickable && onSelect(d.node_id)}
                            className={`w-full text-left px-2 py-1 rounded border text-[11px] flex items-start gap-2 ${
                              active
                                ? 'bg-white border-gray-400 ring-1 ring-gray-300'
                                : `bg-white border-gray-200 ${meta.rowClass}`
                            } ${clickable ? 'cursor-pointer' : 'cursor-default opacity-80'}`}
                            title={clickable ? `点击高亮节点 ${d.node_id}` : ''}
                          >
                            <span className={`shrink-0 ${meta.pillClass.split(' ').slice(1, 2).join(' ')}`}>
                              {meta.icon}
                            </span>
                            <span className="flex-1 text-gray-700 break-words">{d.message}</span>
                            {d.node_id && (
                              <span className="shrink-0 font-mono text-gray-400">
                                → {d.node_id.length > 24 ? d.node_id.slice(0, 23) + '\u2026' : d.node_id}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
