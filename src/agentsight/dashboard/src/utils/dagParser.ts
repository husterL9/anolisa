/**
 * Trace-inferred Evaluation DAG parser.
 *
 * Derives an EvalDag (V, E, τ) from an AtifDocument by mapping each ATIF step
 * to one or more typed nodes per the rules in arXiv:2604.23581 §3.1.
 *
 * Pipeline per step:
 *   system        → SYSTEM (boundary, hangs off main chain)
 *   user          → USER_QUERY (boundary, becomes head of chain)
 *   agent
 *     ├─ reasoning_content      → PLAN
 *     ├─ tool_calls[i]          → TOOLSEL → PARAMGEN
 *     │   ├─ matched obs        → EXEC      (tool_link edge)
 *     │   └─ unmatched obs      → fallback ordered match
 *     └─ message (if any)       → SYNTH
 *
 * Cross-step edges connect the last node of step k to the first node of step k+1
 * (inter_step). Repeated function names within one step trigger loop unrolling
 * (per paper Appendix A): node ids get `#k` suffixes ordered by appearance.
 *
 * If the resulting graph contains zero typed nodes (all steps empty), we degrade
 * to a flat chain over step_ids and emit fallback = 'flat'.
 */

import type {
  AtifDocument,
  AtifStep,
  AtifToolCall,
  AtifObservationResult,
} from '../types';
import type { DagNode, DagEdge, DagNodeType, DagDiagnostic, EvalDag } from '../types/dag';

const PREVIEW_LEN = 2000;

function preview(text: string | undefined | null): string {
  if (!text) return '';
  // Collapse internal whitespace runs to a single space for cleaner preview.
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length <= PREVIEW_LEN ? t : t.slice(0, PREVIEW_LEN) + '\u2026';
}

function previewArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return preview(args);
  try {
    return preview(JSON.stringify(args));
  } catch {
    return preview(String(args));
  }
}

/**
 * Normalize a tool_call_id for matching.
 *
 * Backend ATIF converter currently emits inconsistent ids: `tool_calls[].tool_call_id`
 * keeps underscores (e.g. "call_2313c8...") while `observation.results[].source_call_id`
 * has them stripped (e.g. "call2313c8..."). To make matching robust against this and
 * other casing/whitespace skew, we normalize on both sides before lookup.
 */
function normalizeId(id: string | undefined | null): string {
  if (!id) return '';
  return id.replace(/[_\-\s]/g, '').toLowerCase();
}

/** Track per-function retry counts within a single step for loop unrolling. */
class RetryCounter {
  private counts = new Map<string, number>();
  /** Returns the 1-based iter index for this fn, incrementing on each call. */
  next(fn: string): number {
    const n = (this.counts.get(fn) ?? 0) + 1;
    this.counts.set(fn, n);
    return n;
  }
  /** Final count for fn; 0 if never seen. */
  total(fn: string): number {
    return this.counts.get(fn) ?? 0;
  }
}

/** Node id helpers — keep them deterministic and visually short. */
const ids = {
  system: (s: number) => `s${s}.system`,
  userQuery: (s: number) => `s${s}.user`,
  plan: (s: number) => `s${s}.plan`,
  toolsel: (s: number, fn: string, iter: number, unrolled: boolean) =>
    unrolled ? `s${s}.toolsel.${fn}#${iter}` : `s${s}.toolsel.${fn}`,
  paramgen: (s: number, fn: string, iter: number, unrolled: boolean) =>
    unrolled ? `s${s}.paramgen.${fn}#${iter}` : `s${s}.paramgen.${fn}`,
  exec: (s: number, fn: string, iter: number, unrolled: boolean) =>
    unrolled ? `s${s}.exec.${fn}#${iter}` : `s${s}.exec.${fn}`,
  synth: (s: number) => `s${s}.synth`,
};

/**
 * Convert an ATIF document into a trace-inferred evaluation DAG.
 * Pure function, safe to memoize.
 */
export function parseAtifToDag(doc: AtifDocument): EvalDag {
  const nodes: DagNode[] = [];
  const edges: DagEdge[] = [];
  const warnings: string[] = [];
  const diagnostics: DagDiagnostic[] = [];

  /** Push both a structured diagnostic and the legacy plain-text warning string. */
  const pushDiag = (
    level: DagDiagnostic['level'],
    category: DagDiagnostic['category'],
    message: string,
    ctx?: { step_id?: number; node_id?: string },
  ) => {
    diagnostics.push({ level, category, message, ...ctx });
    warnings.push(message);
  };

  // Tail of the previous step's main chain (for inter_step edges).
  let prevTail: string | null = null;
  // Lookup of every PARAMGEN node id keyed by tool_call_id — used to find target
  // when an EXEC's source_call_id is matched, and for unmatched fallback pairing.
  const paramgenByCallId = new Map<string, string>();
  // Same map but per step, so EXEC matching is local (avoids cross-step bleed).

  for (const step of doc.steps) {
    const stepId = step.step_id;
    const ts = step.timestamp;
    let curTail: string | null = null;
    let curHead: string | null = null;
    let fanOutHandledPrevTail = false;

    if (step.source === 'system') {
      // System prompt: standalone boundary node, does not participate in main chain.
      const node: DagNode = {
        id: ids.system(stepId),
        type: 'SYSTEM',
        step_id: stepId,
        label: 'System',
        preview: preview(step.message),
        timestamp: ts,
      };
      nodes.push(node);
      // Note: prevTail is intentionally NOT updated — system hangs off the chain.
      continue;
    }

    if (step.source === 'user') {
      const node: DagNode = {
        id: ids.userQuery(stepId),
        type: 'USER_QUERY',
        step_id: stepId,
        label: 'User Query',
        preview: preview(step.message),
        timestamp: ts,
      };
      nodes.push(node);
      curHead = curTail = node.id;
    } else if (step.source === 'agent') {
      // Two separate lookups so we can distinguish raw-id matches from normalized-id
      // (the latter signals a backend id-formatting bug worth surfacing as INFO).
      const stepParamgenByCallId = new Map<string, string>();
      const stepParamgenByNormId = new Map<string, string>();
      const stepRetry = new RetryCounter();

      // ── PLAN ────────────────────────────────────────────────────────────
      // Only explicit reasoning_content generates a PLAN node (qwq/o1 models).
      if (step.reasoning_content) {
        const planNode: DagNode = {
          id: ids.plan(stepId),
          type: 'PLAN',
          step_id: stepId,
          label: 'Plan',
          preview: preview(step.reasoning_content),
          timestamp: ts,
        };
        nodes.push(planNode);
        curHead = curHead ?? planNode.id;
        curTail = planNode.id;
      }

      // ── TOOLSEL → PARAMGEN per tool_call (fan-out from PLAN) ───────────
      const toolCalls: AtifToolCall[] = step.tool_calls ?? [];
      // First pass: count function appearances to decide if we need unrolling.
      const fnTotal = new Map<string, number>();
      for (const tc of toolCalls) {
        const fn = tc.function_name ?? 'unknown';
        fnTotal.set(fn, (fnTotal.get(fn) ?? 0) + 1);
      }

      // Fan-out point: all TOOLSELs branch from here (PLAN or step entry)
      // Fan-out fallback: if no PLAN in this step, use prevTail (previous step tail) as fan-out source
      const fanOutPoint = (curTail ?? prevTail) as string | null;
      if (fanOutPoint && fanOutPoint === prevTail && toolCalls.length > 0) fanOutHandledPrevTail = true;
      const allExecIds: string[] = [];

      for (const tc of toolCalls) {
        const fn = tc.function_name ?? 'unknown';
        const total = fnTotal.get(fn) ?? 1;
        const unrolled = total > 1;
        const iter = stepRetry.next(fn);

        const tsNode: DagNode = {
          id: ids.toolsel(stepId, fn, iter, unrolled),
          type: 'TOOLSEL',
          step_id: stepId,
          label: fn,
          preview: `select tool: ${fn}`,
          timestamp: ts,
          tool_call_id: tc.tool_call_id,
          function_name: fn,
          unrolled_iter: unrolled ? iter : undefined,
        };
        nodes.push(tsNode);
        curHead = curHead ?? tsNode.id;
        // Fan-out: each TOOLSEL connects from the fan-out point (not from previous PARAMGEN)
        if (fanOutPoint) edges.push({ from: fanOutPoint, to: tsNode.id, kind: fanOutHandledPrevTail ? 'inter_step' : 'intra_step' });
        // Do NOT update curTail here — sub-chains are independent

        const pgNode: DagNode = {
          id: ids.paramgen(stepId, fn, iter, unrolled),
          type: 'PARAMGEN',
          step_id: stepId,
          label: fn,
          preview: previewArgs(tc.arguments),
          timestamp: ts,
          tool_call_id: tc.tool_call_id,
          function_name: fn,
          unrolled_iter: unrolled ? iter : undefined,
        };
        nodes.push(pgNode);
        edges.push({ from: tsNode.id, to: pgNode.id, kind: 'intra_step' });
        // Do NOT update curTail — sub-chains are independent

        if (tc.tool_call_id) {
          stepParamgenByCallId.set(tc.tool_call_id, pgNode.id);
          paramgenByCallId.set(tc.tool_call_id, pgNode.id);
          const norm = normalizeId(tc.tool_call_id);
          if (norm && norm !== tc.tool_call_id) {
            stepParamgenByNormId.set(norm, pgNode.id);
          }
        }
      }

      // ── EXEC nodes from observation.results ─────────────────────────────
      const obsResults: AtifObservationResult[] = step.observation?.results ?? [];
      // Track which PARAMGEN ids have been matched so unmatched obs can fall back.
      const unmatchedPgIds: string[] = toolCalls
        .map((tc) => (tc.tool_call_id ? stepParamgenByCallId.get(tc.tool_call_id) : undefined))
        .filter((id): id is string => Boolean(id));
      const consumedPg = new Set<string>();

      const execRetry = new RetryCounter();
      for (let i = 0; i < obsResults.length; i++) {
        const r = obsResults[i];
        // Try explicit match first (paper §3.1 strong link via tool_call_id).
        // Match against both raw id and normalized id (backend may strip underscores).
        let pgId: string | undefined;
        let normalizedHit = false;
        if (r.source_call_id) {
          const raw = stepParamgenByCallId.get(r.source_call_id);
          if (raw) {
            pgId = raw;
          } else {
            const norm = stepParamgenByNormId.get(normalizeId(r.source_call_id));
            if (norm) {
              pgId = norm;
              normalizedHit = true;
            }
          }
        }
        let matchKind: 'tool_link' | 'fallback_seq' = 'tool_link';

        // Fallback (paper Appendix A timestamp resolution): take next unmatched PARAMGEN.
        if (!pgId) {
          pgId = unmatchedPgIds.find((id) => !consumedPg.has(id));
          matchKind = 'fallback_seq';
          if (pgId) {
            pushDiag(
              'warn',
              'fallback_match',
              `step ${stepId} obs ${i}: 缺 source_call_id，按顺序兜底匹配到 ${pgId} (missing source_call_id)`,
              { step_id: stepId, node_id: pgId },
            );
          }
        }

        if (!pgId) {
          // No PARAMGEN to attach to — emit a dangling EXEC linked to curTail.
          const fn = r.source_call_id ?? `obs${i}`;
          const total = 1;
          const iter = execRetry.next(fn);
          const execNode: DagNode = {
            id: ids.exec(stepId, fn, iter, total > 1),
            type: 'EXEC',
            step_id: stepId,
            label: fn,
            preview: preview(r.content),
            timestamp: ts,
            tool_call_id: r.source_call_id,
          };
          nodes.push(execNode);
          if (curTail) edges.push({ from: curTail, to: execNode.id, kind: 'fallback_seq' });
          curHead = curHead ?? execNode.id;
          curTail = execNode.id;
          allExecIds.push(execNode.id);
          pushDiag(
            'warn',
            'orphan_obs',
            `step ${stepId} obs ${i}: 找不到匹配的 tool_call (no matching tool_call)`,
            { step_id: stepId, node_id: execNode.id },
          );
          continue;
        }

        consumedPg.add(pgId);
        const sourcePg = nodes.find((n) => n.id === pgId);
        const fn = sourcePg?.function_name ?? sourcePg?.label ?? `obs${i}`;
        const unrolled = sourcePg?.unrolled_iter !== undefined;
        const iter = sourcePg?.unrolled_iter ?? execRetry.next(fn);

        const execNode: DagNode = {
          id: ids.exec(stepId, fn, iter, unrolled),
          type: 'EXEC',
          step_id: stepId,
          label: fn,
          preview: preview(r.content),
          timestamp: ts,
          tool_call_id: r.source_call_id ?? sourcePg?.tool_call_id,
          function_name: fn,
          unrolled_iter: unrolled ? iter : undefined,
        };
        nodes.push(execNode);
        edges.push({ from: pgId, to: execNode.id, kind: matchKind });
        curHead = curHead ?? execNode.id;
        curTail = execNode.id;

        allExecIds.push(execNode.id);
        if (normalizedHit) {
          // Tell the user that backend ids didn't match raw — useful signal for fixing
          // the backend converter without breaking the DAG today.
          pushDiag(
            'info',
            'id_normalized',
            `step ${stepId} obs ${i}: id 通过去下划线归一化匹配（提示后端 id 不一致）`,
            { step_id: stepId, node_id: execNode.id },
          );
        }
      }

      // ── SYNTH (assistant message) ─────────────────────────────────────────
      if (step.message) {
        const synthNode: DagNode = {
          id: ids.synth(stepId),
          type: 'SYNTH',
          step_id: stepId,
          label: 'Synth',
          preview: preview(step.message),
          timestamp: ts,
        };
        nodes.push(synthNode);
        // Fan-in: all EXECs converge into SYNTH (or curTail if no EXECs)
        if (allExecIds.length > 0) {
          for (const execId of allExecIds) {
            edges.push({ from: execId, to: synthNode.id, kind: 'intra_step' });
          }
        } else if (curTail) {
          edges.push({ from: curTail, to: synthNode.id, kind: 'intra_step' });
        }
        curHead = curHead ?? synthNode.id;
        curTail = synthNode.id;
      } else if (allExecIds.length > 0) {
        // No SYNTH but has EXECs — set curTail to last EXEC for inter_step edge
        curTail = allExecIds[allExecIds.length - 1];
      }
    } else {
      // Unknown source — skip but warn.
      pushDiag(
        'warn',
        'unknown_source',
        `step ${stepId}: 未知 source "${step.source}"，已跳过`,
        { step_id: stepId },
      );
      continue;
    }

    // Inter-step edge: chain previous tail into current head if both present.
    // Inter-step edge: skip if fan-out already connected prevTail → all TOOLSELs
    if (prevTail && curHead && !fanOutHandledPrevTail) {
      edges.push({ from: prevTail, to: curHead, kind: 'inter_step' });
    }
    if (curTail) prevTail = curTail;
  }

  // ── Loop unrolling diagnostics ────────────────────────────────────────────
  // Group unrolled nodes per (step, fn) to emit a friendly warning.
  const unrollCounts = new Map<string, number>();
  for (const n of nodes) {
    if (n.unrolled_iter !== undefined && n.function_name) {
      const key = `s${n.step_id}|${n.function_name}|${n.type}`;
      unrollCounts.set(key, Math.max(unrollCounts.get(key) ?? 0, n.unrolled_iter));
    }
  }
  for (const [key, max] of unrollCounts) {
    const [s, fn, type] = key.split('|');
    if (type === 'TOOLSEL' && max >= 2) {
      // Find the first unrolled TOOLSEL node so the panel can jump to it.
      const stepIdNum = Number(s.replace(/^s/, ''));
      const firstNode = nodes.find(
        (n) =>
          n.step_id === stepIdNum &&
          n.type === 'TOOLSEL' &&
          n.function_name === fn &&
          n.unrolled_iter === 1,
      );
      pushDiag(
        'info',
        'unroll',
        `${s}: ${fn} 并行调用 x${max}，已展开为独立节点 (unrolled retry ${fn} x${max})`,
        { step_id: stepIdNum, node_id: firstNode?.id },
      );
    }
  }

  // ── Flat fallback ─────────────────────────────────────────────────────────
  // If we produced zero typed nodes (only boundary or nothing), degrade to a
  // pure step-id-ordered chain (paper Appendix A 0.8% fallback).
  const typedCount = nodes.filter(
    (n) => n.type !== 'SYSTEM' && n.type !== 'USER_QUERY',
  ).length;
  if (typedCount === 0 && doc.steps.length > 0) {
    const flatNodes: DagNode[] = doc.steps.map((s: AtifStep) => ({
      id: `s${s.step_id}.flat`,
      type: 'SYNTH' as DagNodeType,
      step_id: s.step_id,
      label: s.source,
      preview: preview(s.message),
      timestamp: s.timestamp,
    }));
    const flatEdges: DagEdge[] = [];
    for (let i = 1; i < flatNodes.length; i++) {
      flatEdges.push({
        from: flatNodes[i - 1].id,
        to: flatNodes[i].id,
        kind: 'fallback_seq',
      });
    }
    pushDiag('error', 'flat_fallback', `fallback: 无法推断节点类型，整个 trace 退化为线性链 (flat chain)`);
    return { nodes: flatNodes, edges: flatEdges, warnings, diagnostics, fallback: 'flat' };
  }

  return { nodes, edges, warnings, diagnostics, fallback: 'none' };
}

/** Group nodes by their source step_id for per-step rendering. */
export function groupNodesByStep(dag: EvalDag): Map<number, DagNode[]> {
  const map = new Map<number, DagNode[]>();
  for (const n of dag.nodes) {
    const arr = map.get(n.step_id) ?? [];
    arr.push(n);
    map.set(n.step_id, arr);
  }
  return map;
}
