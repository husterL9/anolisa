//! AgentEval Algorithm 1 implementation — the main evaluation loop.
//!
//! Pipeline:
//!   1. Load ATIF → parse DAG (dag_parser)
//!   2. Topological sort
//!   3. For each node in order:
//!      a. Aggregate parent context
//!      b. Call LLM judge with type-specific rubric
//!      c. If score < threshold → classify failure → attribute root cause
//!   4. Produce EvalReport

use super::dag_parser::{parse_atif_to_eval_dag, topological_sort, get_parents};
use super::judge::{call_judge, JudgeConfig};
use super::rubrics;
use super::taxonomy::{build_taxonomy_prompt, parse_taxonomy_response, TAXONOMY};
use super::types::*;
use crate::atif::schema::AtifDocument;

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

/// Run the complete Algorithm 1 evaluation on an ATIF document.
pub fn evaluate(doc: &AtifDocument, config: &JudgeConfig) -> Result<EvalReport, String> {
    let eval_id = generate_eval_id();
    let created_at = unix_now();

    // 1. Parse DAG
    let dag = parse_atif_to_eval_dag(doc);
    if dag.nodes.is_empty() {
        return Err("DAG has no evaluable nodes".to_string());
    }

    // 2. Topological sort
    let sorted_ids = topological_sort(&dag);

    // 3. Build node lookup
    let node_map: HashMap<&str, &EvalDagNode> = dag.nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    // 4. Evaluate each node in topological order
    let mut results: Vec<NodeEvalResult> = Vec::new();
    let mut score_map: HashMap<String, u8> = HashMap::new(); // node_id → score

    for node_id in &sorted_ids {
        let node = match node_map.get(node_id.as_str()) {
            Some(n) => *n,
            None => continue,
        };

        // Skip boundary nodes (SYSTEM, USER_QUERY) — they are not scored.
        if node.node_type == "SYSTEM" || node.node_type == "USER_QUERY" {
            continue;
        }

        // a. Aggregate context from parent nodes
        let parent_ids = get_parents(&node.id, &dag);
        let upstream_context = aggregate_context(&parent_ids, &dag, &results);

        // b. Build rubric prompt and call judge
        let (system_prompt, user_prompt) = build_prompts(
            &node.node_type,
            &node.user_query,
            &upstream_context,
            &node.content,
        );

        let judge_response = call_judge(config, &system_prompt, &user_prompt)?;

        let score = judge_response.score.unwrap_or(3); // default to 3 if parse fails
        let threshold = threshold_for_type(&node.node_type);
        let is_failure = score < threshold;

        // c. Failure classification + root cause attribution
        let mut failure_class = None;
        let mut attribution = Attribution::Pass;

        if is_failure {
            // Classify failure using taxonomy
            let tax_prompt = build_taxonomy_prompt(
                &node.node_type,
                &node.content,
                &upstream_context,
                score,
            );
            // Split taxonomy prompt into system/user for the API call
            let tax_response = call_judge(config, &tax_prompt, "Classify this failure.");
            if let Ok(resp) = tax_response {
                if let Some(idx) = parse_taxonomy_response(&resp.content) {
                    let entry = &TAXONOMY[idx];
                    failure_class = Some(FailureClass {
                        level1: entry.level1.to_string(),
                        level2: entry.level2.to_string(),
                        level3: entry.level3.to_string(),
                        explanation: resp.content.lines().take(3).collect::<Vec<_>>().join(" "),
                    });
                }
            }

            // Root cause attribution (greedy heuristic from paper Algorithm 1 lines 7-13)
            let failed_parents: Vec<&str> = parent_ids
                .iter()
                .filter(|pid| score_map.get(**pid).copied().unwrap_or(5) < threshold_for_type(
                    node_map.get(**pid).map(|n| n.node_type.as_str()).unwrap_or("SYNTH")
                ))
                .copied()
                .collect();

            if failed_parents.is_empty() {
                attribution = Attribution::RootCause;
            } else {
                // Select parent with lowest score
                let worst_parent = failed_parents
                    .iter()
                    .min_by_key(|pid| score_map.get(**pid).copied().unwrap_or(5))
                    .unwrap();
                attribution = Attribution::PropagatedFrom(worst_parent.to_string());
            }
        }

        score_map.insert(node.id.clone(), score);

        results.push(NodeEvalResult {
            node_id: node.id.clone(),
            node_type: node.node_type.clone(),
            score,
            reasoning: judge_response.content,
            is_failure,
            failure_class,
            attribution,
        });
    }

    // 5. Compute summary
    let summary = compute_summary(&results);

    Ok(EvalReport {
        eval_id,
        session_id: doc.session_id.clone(),
        judge_model: config.model.clone(),
        created_at,
        completed_at: unix_now(),
        status: EvalStatus::Completed,
        nodes: results,
        summary: Some(summary),
        error: None,
    })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn build_prompts(
    node_type: &str,
    user_query: &str,
    upstream_context: &str,
    node_output: &str,
) -> (String, String) {
    // For simplicity, split rubrics into system (evaluator instructions) and user (data)
    let full_prompt = rubrics::build_scoring_prompt(node_type, user_query, upstream_context, node_output);
    // The build_scoring_prompt returns "System:\n...\n\nUser:\n..."
    if let Some(idx) = full_prompt.find("\n\nUser:\n") {
        let system = full_prompt[7..idx].to_string(); // skip "System:\n"
        let user = full_prompt[idx + 7..].to_string(); // skip "\n\nUser:\n"
        (system, user)
    } else {
        // Fallback: entire thing as user prompt
        (String::new(), full_prompt)
    }
}

/// Aggregate context from parent nodes for evaluation.
fn aggregate_context(parent_ids: &[&str], dag: &EvalDag, results: &[NodeEvalResult]) -> String {
    let mut parts = Vec::new();
    for pid in parent_ids {
        if let Some(node) = dag.nodes.iter().find(|n| n.id == *pid) {
            let content_preview = if node.content.len() > 500 {
                format!("{}...(truncated)", &node.content[..500])
            } else {
                node.content.clone()
            };
            parts.push(format!("[{}:{}] {}", node.node_type, node.label, content_preview));
        }
    }
    if parts.is_empty() {
        "(no upstream context)".to_string()
    } else {
        parts.join("\n\n")
    }
}

fn compute_summary(results: &[NodeEvalResult]) -> EvalSummary {
    let total = results.len();
    let failures = results.iter().filter(|r| r.is_failure).count();
    let root_causes = results.iter().filter(|r| r.attribution == Attribution::RootCause).count();
    let propagated = results.iter().filter(|r| matches!(r.attribution, Attribution::PropagatedFrom(_))).count();
    let avg_score = if total > 0 {
        results.iter().map(|r| r.score as f64).sum::<f64>() / total as f64
    } else {
        0.0
    };

    EvalSummary {
        total_nodes: total,
        evaluated_nodes: total,
        avg_score,
        failure_count: failures,
        root_cause_count: root_causes,
        propagated_count: propagated,
    }
}

fn generate_eval_id() -> String {
    use std::fmt::Write;
    let now = unix_now();
    let mut id = String::with_capacity(24);
    write!(id, "eval-{:x}-{:04x}", now, rand_u16()).unwrap_or(());
    id
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn rand_u16() -> u16 {
    // Simple pseudo-random without external crate
    let ptr = Box::into_raw(Box::new(0u8));
    let val = (ptr as usize & 0xFFFF) as u16;
    unsafe { drop(Box::from_raw(ptr)) };
    val
}
