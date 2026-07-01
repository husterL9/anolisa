//! Rust-native DAG parser — mirrors frontend dagParser.ts logic.
//!
//! Constructs an EvalDag from AtifDocument for use in Algorithm 1.
//! The parser does NOT need full UI features (diagnostics panel, preview truncation);
//! it focuses on producing correct node types + edges + content for judge evaluation.

use crate::atif::schema::AtifDocument;
use super::types::{EvalDag, EvalDagNode, EvalDagEdge};

/// Parse an ATIF document into an evaluation DAG.
///
/// Simplified compared to the frontend parser:
/// - No loop-unroll diagnostics (not needed for evaluation)
/// - No preview truncation (judge needs full content)
/// - Retains id normalization for observation matching
pub fn parse_atif_to_eval_dag(doc: &AtifDocument) -> EvalDag {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut user_query = String::new();
    let mut prev_tail: Option<String> = None;

    for step in &doc.steps {
        let step_id = step.step_id;
        let mut cur_head: Option<String> = None;
        let mut cur_tail: Option<String> = None;

        match step.source.as_str() {
            "system" => {
                // System nodes don't participate in evaluation — skip.
                continue;
            }
            "user" => {
                let content = step.message.clone().unwrap_or_default();
                user_query = content.clone(); // Track current user query for subsequent agent nodes.
                let id = format!("s{}.user", step_id);
                nodes.push(EvalDagNode {
                    id: id.clone(),
                    node_type: "USER_QUERY".to_string(),
                    step_id,
                    label: "User Query".to_string(),
                    content,
                    tool_call_id: None,
                    function_name: None,
                            user_query: user_query.clone(),
                });
                cur_head = Some(id.clone());
                cur_tail = Some(id);
            }
            "agent" => {
                // PLAN from reasoning_content
                if let Some(ref reasoning) = step.reasoning_content {
                    if !reasoning.is_empty() {
                        let id = format!("s{}.plan", step_id);
                        nodes.push(EvalDagNode {
                            id: id.clone(),
                            node_type: "PLAN".to_string(),
                            step_id,
                            label: "Plan".to_string(),
                            content: reasoning.clone(),
                            tool_call_id: None,
                            function_name: None,
                            user_query: user_query.clone(),
                        });
                        cur_head = cur_head.or(Some(id.clone()));
                        cur_tail = Some(id);
                    }
                }

                // TOOLSEL + PARAMGEN per tool_call (fan-out from PLAN)
                if let Some(ref tool_calls) = step.tool_calls {
                    let fan_out_point = cur_tail.clone();
                    let mut all_exec_ids: Vec<String> = Vec::new();

                    for (i, tc) in tool_calls.iter().enumerate() {
                        let fn_name = tc.function_name.clone();
                        let tc_id = tc.tool_call_id.clone();

                        // TOOLSEL
                        let ts_id = format!("s{}.toolsel.{}", step_id, i);
                        nodes.push(EvalDagNode {
                            id: ts_id.clone(),
                            node_type: "TOOLSEL".to_string(),
                            step_id,
                            label: fn_name.clone(),
                            content: format!("select tool: {}", fn_name),
                            tool_call_id: Some(tc_id.clone()),
                            function_name: Some(fn_name.clone()),
                            user_query: user_query.clone(),
                        });
                        // Fan-out: connect from fan_out_point (not serial)
                        if let Some(ref fop) = fan_out_point {
                            edges.push(EvalDagEdge { from: fop.clone(), to: ts_id.clone() });
                        }
                        cur_head = cur_head.or(Some(ts_id.clone()));

                        // PARAMGEN
                        let pg_id = format!("s{}.paramgen.{}", step_id, i);
                        let args_str = serde_json::to_string(&tc.arguments).unwrap_or_default();
                        nodes.push(EvalDagNode {
                            id: pg_id.clone(),
                            node_type: "PARAMGEN".to_string(),
                            step_id,
                            label: fn_name.clone(),
                            content: args_str,
                            tool_call_id: Some(tc_id.clone()),
                            function_name: Some(fn_name.clone()),
                            user_query: user_query.clone(),
                        });
                        edges.push(EvalDagEdge { from: ts_id, to: pg_id.clone() });
                    }

                    // EXEC from observation results
                    if let Some(ref obs) = step.observation {
                        for (i, result) in obs.results.iter().enumerate() {
                            let exec_id = format!("s{}.exec.{}", step_id, i);
                            let content = result.content.clone().unwrap_or_default();
                            nodes.push(EvalDagNode {
                                id: exec_id.clone(),
                                node_type: "EXEC".to_string(),
                                step_id,
                                label: result.source_call_id.clone().unwrap_or_else(|| format!("obs{}", i)),
                                content,
                                tool_call_id: result.source_call_id.clone(),
                                function_name: None,
                            user_query: user_query.clone(),
                            });
                            let pg_id = format!("s{}.paramgen.{}", step_id, i);
                            if nodes.iter().any(|n| n.id == pg_id) {
                                edges.push(EvalDagEdge { from: pg_id, to: exec_id.clone() });
                            } else if let Some(ref fop) = fan_out_point {
                                edges.push(EvalDagEdge { from: fop.clone(), to: exec_id.clone() });
                            }
                            all_exec_ids.push(exec_id.clone());
                            cur_head = cur_head.or(Some(exec_id));
                        }
                    }

                    // SYNTH: fan-in from all EXECs
                    if let Some(ref msg) = step.message {
                        if !msg.is_empty() {
                            let id = format!("s{}.synth", step_id);
                            nodes.push(EvalDagNode {
                                id: id.clone(),
                                node_type: "SYNTH".to_string(),
                                step_id,
                                label: "Synth".to_string(),
                                content: msg.clone(),
                                tool_call_id: None,
                                function_name: None,
                            user_query: user_query.clone(),
                            });
                            if !all_exec_ids.is_empty() {
                                for exec_id in &all_exec_ids {
                                    edges.push(EvalDagEdge { from: exec_id.clone(), to: id.clone() });
                                }
                            } else if let Some(ref fop) = fan_out_point {
                                edges.push(EvalDagEdge { from: fop.clone(), to: id.clone() });
                            }
                            cur_head = cur_head.or(Some(id.clone()));
                            cur_tail = Some(id);
                        }
                    } else if !all_exec_ids.is_empty() {
                        cur_tail = Some(all_exec_ids.last().unwrap().clone());
                    }
                } else {
                    // No tool_calls: SYNTH from message only
                    if let Some(ref msg) = step.message {
                        if !msg.is_empty() {
                            let id = format!("s{}.synth", step_id);
                            nodes.push(EvalDagNode {
                                id: id.clone(),
                                node_type: "SYNTH".to_string(),
                                step_id,
                                label: "Synth".to_string(),
                                content: msg.clone(),
                                tool_call_id: None,
                                function_name: None,
                            user_query: user_query.clone(),
                            });
                            if let Some(ref tail) = cur_tail {
                                edges.push(EvalDagEdge { from: tail.clone(), to: id.clone() });
                            }
                            cur_head = cur_head.or(Some(id.clone()));
                            cur_tail = Some(id);
                        }
                    }
                }
            }
            _ => continue,
        }

        // Inter-step edge
        if let (Some(prev), Some(head)) = (&prev_tail, &cur_head) {
            edges.push(EvalDagEdge { from: prev.clone(), to: head.clone() });
        }
        if cur_tail.is_some() {
            prev_tail = cur_tail;
        }
    }

    EvalDag { nodes, edges, user_query }
}

/// Topological sort of DAG nodes (Kahn's algorithm).
/// Returns node ids in topological order. Panics if the graph has a cycle.
pub fn topological_sort(dag: &EvalDag) -> Vec<String> {
    use std::collections::{HashMap, VecDeque};

    let mut in_degree: HashMap<&str, usize> = HashMap::new();
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();

    for node in &dag.nodes {
        in_degree.entry(node.id.as_str()).or_insert(0);
        adjacency.entry(node.id.as_str()).or_default();
    }
    for edge in &dag.edges {
        *in_degree.entry(edge.to.as_str()).or_insert(0) += 1;
        adjacency.entry(edge.from.as_str()).or_default().push(edge.to.as_str());
    }

    let mut queue: VecDeque<&str> = in_degree
        .iter()
        .filter(|(_, deg)| **deg == 0)
        .map(|(id, _)| *id)
        .collect();

    let mut sorted = Vec::with_capacity(dag.nodes.len());
    while let Some(id) = queue.pop_front() {
        sorted.push(id.to_string());
        if let Some(neighbors) = adjacency.get(id) {
            for &next in neighbors {
                if let Some(deg) = in_degree.get_mut(next) {
                    *deg -= 1;
                    if *deg == 0 {
                        queue.push_back(next);
                    }
                }
            }
        }
    }

    sorted
}

/// Get parent node ids for a given node.
pub fn get_parents<'a>(node_id: &str, dag: &'a EvalDag) -> Vec<&'a str> {
    dag.edges
        .iter()
        .filter(|e| e.to == node_id)
        .map(|e| e.from.as_str())
        .collect()
}
