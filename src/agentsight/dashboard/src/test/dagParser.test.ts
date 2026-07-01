import { describe, it, expect } from 'vitest';
import type { AtifDocument } from '../types';
import { parseAtifToDag, groupNodesByStep } from '../utils/dagParser';

function baseDoc(steps: AtifDocument['steps']): AtifDocument {
  return {
    schema_version: 'ATIF-v1.6',
    session_id: 'test-session',
    agent: { name: 'TestAgent', version: '1.0.0' },
    steps,
  };
}

describe('parseAtifToDag', () => {
  it('plain conversation: system + user + agent[message] → SYSTEM, USER_QUERY, SYNTH', () => {
    const doc = baseDoc([
      { step_id: 1, source: 'system', message: 'You are helpful.' },
      { step_id: 2, source: 'user', message: 'Hi' },
      { step_id: 3, source: 'agent', message: 'Hello!' },
    ]);
    const dag = parseAtifToDag(doc);

    expect(dag.fallback).toBe('none');
    expect(dag.nodes).toHaveLength(3);
    expect(dag.nodes.map((n) => n.type)).toEqual(['SYSTEM', 'USER_QUERY', 'SYNTH']);

    // SYSTEM hangs off main chain; only USER_QUERY → SYNTH inter_step edge expected.
    expect(dag.edges).toHaveLength(1);
    expect(dag.edges[0]).toMatchObject({
      from: 's2.user',
      to: 's3.synth',
      kind: 'inter_step',
    });
  });

  it('single tool call: agent with reasoning + 1 tool_call + observation + message → 5-node chain', () => {
    const doc = baseDoc([
      { step_id: 1, source: 'user', message: 'list files' },
      {
        step_id: 2,
        source: 'agent',
        reasoning_content: 'I will use bash',
        tool_calls: [
          { tool_call_id: 'tc1', function_name: 'bash', arguments: { cmd: 'ls' } },
        ],
        observation: { results: [{ source_call_id: 'tc1', content: 'a.txt\nb.txt' }] },
        message: 'There are 2 files.',
      },
    ]);
    const dag = parseAtifToDag(doc);

    expect(dag.fallback).toBe('none');
    const types = dag.nodes.map((n) => n.type);
    expect(types).toEqual(['USER_QUERY', 'PLAN', 'TOOLSEL', 'PARAMGEN', 'EXEC', 'SYNTH']);

    // Main intra-step chain PLAN→TOOLSEL→PARAMGEN→EXEC→SYNTH.
    const edgeKinds = dag.edges.map((e) => `${e.from}->${e.to}:${e.kind}`);
    expect(edgeKinds).toContain('s1.user->s2.plan:inter_step');
    expect(edgeKinds).toContain('s2.plan->s2.toolsel.bash:intra_step');
    expect(edgeKinds).toContain('s2.toolsel.bash->s2.paramgen.bash:intra_step');
    expect(edgeKinds).toContain('s2.paramgen.bash->s2.exec.bash:tool_link');
    expect(edgeKinds).toContain('s2.exec.bash->s2.synth:intra_step');

    // EXEC node should carry function_name and tool_call_id.
    const exec = dag.nodes.find((n) => n.type === 'EXEC')!;
    expect(exec.function_name).toBe('bash');
    expect(exec.tool_call_id).toBe('tc1');
  });

  it('parallel tool calls in one step: 2 tool_calls → 2 sub-chains', () => {
    const doc = baseDoc([
      {
        step_id: 1,
        source: 'agent',
        reasoning_content: 'use two tools',
        tool_calls: [
          { tool_call_id: 'a1', function_name: 'bash', arguments: { cmd: 'ls' } },
          { tool_call_id: 'b1', function_name: 'read', arguments: { path: '/tmp' } },
        ],
        observation: {
          results: [
            { source_call_id: 'a1', content: 'ls out' },
            { source_call_id: 'b1', content: 'read out' },
          ],
        },
      },
    ]);
    const dag = parseAtifToDag(doc);

    // PLAN + 2*(TOOLSEL+PARAMGEN+EXEC) = 7 nodes.
    expect(dag.nodes).toHaveLength(7);
    const ids = dag.nodes.map((n) => n.id);
    expect(ids).toContain('s1.toolsel.bash');
    expect(ids).toContain('s1.paramgen.bash');
    expect(ids).toContain('s1.exec.bash');
    expect(ids).toContain('s1.toolsel.read');
    expect(ids).toContain('s1.paramgen.read');
    expect(ids).toContain('s1.exec.read');

    // Both PARAMGEN→EXEC links should be tool_link (explicit source_call_id).
    const toolLinks = dag.edges.filter((e) => e.kind === 'tool_link');
    expect(toolLinks).toHaveLength(2);
  });

  it('retry loop: same function called twice → unrolled with #1 / #2 suffixes', () => {
    const doc = baseDoc([
      {
        step_id: 1,
        source: 'agent',
        tool_calls: [
          { tool_call_id: 't1', function_name: 'bash', arguments: { cmd: 'ls' } },
          { tool_call_id: 't2', function_name: 'bash', arguments: { cmd: 'ls -la' } },
        ],
        observation: {
          results: [
            { source_call_id: 't1', content: 'first attempt' },
            { source_call_id: 't2', content: 'second attempt' },
          ],
        },
      },
    ]);
    const dag = parseAtifToDag(doc);

    const ids = dag.nodes.map((n) => n.id);
    expect(ids).toContain('s1.toolsel.bash#1');
    expect(ids).toContain('s1.toolsel.bash#2');
    expect(ids).toContain('s1.exec.bash#1');
    expect(ids).toContain('s1.exec.bash#2');

    const tsNode1 = dag.nodes.find((n) => n.id === 's1.toolsel.bash#1')!;
    expect(tsNode1.unrolled_iter).toBe(1);
    expect(tsNode1.function_name).toBe('bash');

    expect(dag.warnings.some((w) => w.includes('unrolled retry bash x2'))).toBe(true);
  });

  it('observation missing source_call_id → fallback ordered match with warning', () => {
    const doc = baseDoc([
      {
        step_id: 1,
        source: 'agent',
        tool_calls: [
          { tool_call_id: 'tc1', function_name: 'bash', arguments: { cmd: 'ls' } },
        ],
        observation: { results: [{ content: 'orphan output' }] },
      },
    ]);
    const dag = parseAtifToDag(doc);

    // PARAMGEN→EXEC edge should be fallback_seq (not tool_link) because we matched by order.
    const pgToExec = dag.edges.find(
      (e) => e.from === 's1.paramgen.bash' && e.to.startsWith('s1.exec'),
    );
    expect(pgToExec?.kind).toBe('fallback_seq');
    expect(dag.warnings.some((w) => w.includes('missing source_call_id'))).toBe(true);
  });

  it('empty / message-less steps → flat fallback', () => {
    const doc = baseDoc([
      { step_id: 1, source: 'agent' },
      { step_id: 2, source: 'agent' },
      { step_id: 3, source: 'agent' },
    ]);
    const dag = parseAtifToDag(doc);

    expect(dag.fallback).toBe('flat');
    expect(dag.nodes).toHaveLength(3);
    expect(dag.edges.every((e) => e.kind === 'fallback_seq')).toBe(true);
    expect(dag.warnings.some((w) => w.includes('flat chain'))).toBe(true);
  });

  it('cross-step inter_step edge connects previous tail to next head', () => {
    const doc = baseDoc([
      { step_id: 1, source: 'user', message: 'q1' },
      { step_id: 2, source: 'agent', message: 'a1' },
      { step_id: 3, source: 'user', message: 'q2' },
      { step_id: 4, source: 'agent', message: 'a2' },
    ]);
    const dag = parseAtifToDag(doc);
    const interEdges = dag.edges.filter((e) => e.kind === 'inter_step');
    expect(interEdges.map((e) => `${e.from}->${e.to}`)).toEqual([
      's1.user->s2.synth',
      's2.synth->s3.user',
      's3.user->s4.synth',
    ]);
  });

  it('groupNodesByStep buckets nodes by step_id', () => {
    const doc = baseDoc([
      { step_id: 1, source: 'user', message: 'q' },
      {
        step_id: 2,
        source: 'agent',
        reasoning_content: 'r',
        message: 'a',
      },
    ]);
    const dag = parseAtifToDag(doc);
    const grouped = groupNodesByStep(dag);
    expect(grouped.get(1)?.map((n) => n.type)).toEqual(['USER_QUERY']);
    expect(grouped.get(2)?.map((n) => n.type)).toEqual(['PLAN', 'SYNTH']);
  });

  it('id matching is tolerant to underscore / case differences (backend bug workaround)', () => {
    // Backend currently strips underscores from observation.source_call_id while keeping them
    // in tool_calls[].tool_call_id. The parser must still pair them up via normalized id.
    const doc = baseDoc([
      {
        step_id: 1,
        source: 'agent',
        tool_calls: [
          { tool_call_id: 'call_AAA_111', function_name: 'bash', arguments: { c: 'ls' } },
        ],
        observation: { results: [{ source_call_id: 'callaaa111', content: 'ok' }] },
      },
    ]);
    const dag = parseAtifToDag(doc);
    const link = dag.edges.find(
      (e) => e.from === 's1.paramgen.bash' && e.to.startsWith('s1.exec.bash'),
    );
    expect(link?.kind).toBe('tool_link');
    expect(dag.warnings.some((w) => w.includes('missing source_call_id'))).toBe(false);
    expect(dag.warnings.some((w) => w.includes('no matching tool_call'))).toBe(false);

    // Diagnostic should be emitted as INFO/id_normalized so the user sees the backend hint.
    const norm = dag.diagnostics.find((d) => d.category === 'id_normalized');
    expect(norm?.level).toBe('info');
    expect(norm?.step_id).toBe(1);
  });

  it('produces leveled diagnostics with correct categorization', () => {
    // Trace exercising unroll (info) + orphan_obs (warn).
    const doc = baseDoc([
      {
        step_id: 1,
        source: 'agent',
        tool_calls: [
          { tool_call_id: 't1', function_name: 'bash', arguments: { c: 'ls' } },
          { tool_call_id: 't2', function_name: 'bash', arguments: { c: 'pwd' } },
        ],
        observation: {
          results: [
            { source_call_id: 't1', content: 'a' },
            { source_call_id: 't2', content: 'b' },
            { source_call_id: 'does-not-exist', content: 'orphan' },
          ],
        },
      },
    ]);
    const dag = parseAtifToDag(doc);

    const byLevel = (lv: 'info' | 'warn' | 'error') =>
      dag.diagnostics.filter((d) => d.level === lv).length;
    expect(byLevel('info')).toBeGreaterThanOrEqual(1);   // unroll
    expect(byLevel('warn')).toBeGreaterThanOrEqual(1);   // orphan_obs
    expect(byLevel('error')).toBe(0);

    const cats = new Set(dag.diagnostics.map((d) => d.category));
    expect(cats.has('unroll')).toBe(true);
    expect(cats.has('orphan_obs')).toBe(true);

    const unroll = dag.diagnostics.find((d) => d.category === 'unroll')!;
    expect(unroll.step_id).toBe(1);
    expect(unroll.node_id).toBe('s1.toolsel.bash#1');
  });

  it('flat fallback emits an ERROR-level diagnostic', () => {
    const doc = baseDoc([
      { step_id: 1, source: 'agent' },
      { step_id: 2, source: 'agent' },
    ]);
    const dag = parseAtifToDag(doc);
    expect(dag.fallback).toBe('flat');
    const errs = dag.diagnostics.filter((d) => d.level === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].category).toBe('flat_fallback');
  });
});
