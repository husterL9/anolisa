/**
 * Evaluation DAG types based on AgentEval (arXiv:2604.23581) §3.1.
 *
 * An evaluation DAG is the tuple G = (V, E, τ, M) where:
 *   - V: evaluation nodes (one per agent step)
 *   - E: directed dependency edges
 *   - τ: node → step type mapping
 *   - M: node → applicable quality metrics (not modeled here, deferred to evaluator)
 *
 * Beyond the 5 paper-defined types we add 2 boundary types (SYSTEM, USER_QUERY)
 * to anchor the trace context; these do not participate in LLM-as-judge scoring.
 */

/** Node type. PLAN/TOOLSEL/PARAMGEN/EXEC/SYNTH follow the paper; SYSTEM/USER_QUERY are boundary. */
export type DagNodeType =
  | 'SYSTEM'
  | 'USER_QUERY'
  | 'PLAN'
  | 'TOOLSEL'
  | 'PARAMGEN'
  | 'EXEC'
  | 'SYNTH';

/** A single DAG node corresponding to one atomic agent step. */
export interface DagNode {
  /** Stable unique id, e.g. "s2.plan", "s3.toolsel.0", "s3.exec.tc1", "s4.toolsel.bash#2". */
  id: string;
  /** Step type, drives evaluator selection in future LLM-as-judge phase. */
  type: DagNodeType;
  /** Source ATIF step_id this node was derived from. */
  step_id: number;
  /** Display label (function name for tool-related nodes, "Plan"/"Synth"/etc otherwise). */
  label: string;
  /** First ~80 chars of the underlying content, for tooltips. */
  preview: string;
  /** Optional ISO timestamp inherited from the source step. */
  timestamp?: string;
  /** Tool-call related fields, only set for TOOLSEL/PARAMGEN/EXEC. */
  tool_call_id?: string;
  function_name?: string;
  /** Loop-unroll iteration index when the same function is retried within one step. */
  unrolled_iter?: number;
}

/** Edge kind, mainly used to drive visual styling. */
export type DagEdgeKind =
  | 'intra_step'    // PLAN → TOOLSEL → PARAMGEN → EXEC → SYNTH within one step
  | 'inter_step'    // last node of step k → first node of step k+1
  | 'tool_link'     // PARAMGEN.tool_call_id ↔ EXEC.source_call_id explicit binding
  | 'fallback_seq'; // pure timestamp / index ordering when no signal exists

export interface DagEdge {
  from: string;
  to: string;
  kind: DagEdgeKind;
}

/** Parser fallback strategy applied to the trace. */
export type DagFallback = 'none' | 'flat';

/** Severity level of a parser diagnostic, used for triage UI color coding. */
export type WarnLevel = 'info' | 'warn' | 'error';

/** Stable category id for grouping diagnostics in the UI. */
export type DagDiagCategory =
  | 'unroll'           // INFO  same fn called >=2 times within one step, loop-unrolled
  | 'id_normalized'    // INFO  matched only after id normalization (backend id mismatch)
  | 'fallback_match'   // WARN  observation missing source_call_id, ordered fallback worked
  | 'orphan_obs'       // WARN  observation has no matchable tool_call at all
  | 'unknown_source'   // WARN  step.source unknown, skipped
  | 'flat_fallback';   // ERROR entire trace degraded to a flat chain

/** A single structured diagnostic emitted by the parser. */
export interface DagDiagnostic {
  level: WarnLevel;
  category: DagDiagCategory;
  message: string;
  /** Source ATIF step this diagnostic relates to, if any. */
  step_id?: number;
  /** DAG node id this diagnostic relates to, used for click-to-highlight. */
  node_id?: string;
}

/** Final evaluation DAG output. */
export interface EvalDag {
  nodes: DagNode[];
  edges: DagEdge[];
  /** Plain-text diagnostics (kept for backward compatibility with existing tests). */
  warnings: string[];
  /** Structured diagnostics with severity + category, used by the triage panel. */
  diagnostics: DagDiagnostic[];
  /** 'flat' means we degraded to a pure linear chain (paper Appendix A). */
  fallback: DagFallback;
}
