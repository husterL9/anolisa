//! Per-type evaluation rubrics for LLM-as-judge scoring (paper §3.2, Appendix C).
//!
//! Each rubric is a structured prompt that:
//!   1. Instructs the judge to evaluate a specific quality dimension
//!   2. Provides a 1-5 scoring scale with clear anchors
//!   3. Requires chain-of-thought reasoning before the final score
//!   4. Ends with "Score: N" on a separate line for parsing

/// Build the complete judge prompt for a given node.
///
/// # Arguments
/// - `node_type`: PLAN / TOOLSEL / PARAMGEN / EXEC / SYNTH
/// - `user_query`: The original user message (anchor for PLAN evaluation)
/// - `upstream_context`: Aggregated output from parent nodes (anchor for non-PLAN types)
/// - `node_output`: The agent's output at this node to be evaluated
pub fn build_scoring_prompt(
    node_type: &str,
    user_query: &str,
    upstream_context: &str,
    node_output: &str,
) -> String {
    let system = system_prompt_for_type(node_type);
    let user_msg = user_message_for_type(node_type, user_query, upstream_context, node_output);
    format!(
        "System:\n{}\n\nUser:\n{}",
        system, user_msg
    )
}

fn system_prompt_for_type(node_type: &str) -> &'static str {
    match node_type {
        "PLAN" => SYSTEM_PLAN,
        "TOOLSEL" => SYSTEM_TOOLSEL,
        "PARAMGEN" => SYSTEM_PARAMGEN,
        "EXEC" => SYSTEM_EXEC,
        "SYNTH" => SYSTEM_SYNTH,
        _ => SYSTEM_SYNTH, // fallback
    }
}

fn user_message_for_type(
    node_type: &str,
    user_query: &str,
    upstream_context: &str,
    node_output: &str,
) -> String {
    match node_type {
        "PLAN" => format!(
            "Original user query:\n{}\n\nAgent's plan/reasoning:\n{}\n\nEvaluate this plan.",
            user_query, node_output
        ),
        "TOOLSEL" => format!(
            "Upstream plan/context:\n{}\n\nTool selected by agent: {}\n\nEvaluate this tool selection.",
            upstream_context, node_output
        ),
        "PARAMGEN" => format!(
            "Selected tool and context:\n{}\n\nParameters generated:\n{}\n\nEvaluate parameter quality.",
            upstream_context, node_output
        ),
        "EXEC" => format!(
            "Expected action:\n{}\n\nTool execution result:\n{}\n\nEvaluate execution outcome.",
            upstream_context, node_output
        ),
        "SYNTH" => format!(
            "Original user query:\n{}\n\nUpstream tool results:\n{}\n\nAgent's final response:\n{}\n\nEvaluate this synthesis.",
            user_query, upstream_context, node_output
        ),
        _ => format!(
            "Context:\n{}\n\nOutput:\n{}\n\nEvaluate quality.",
            upstream_context, node_output
        ),
    }
}

// ─── System prompts per type ─────────────────────────────────────────────────

const SYSTEM_PLAN: &str = r#"You are an expert evaluator assessing the quality of an AI agent's planning step.

Evaluate the agent's plan/reasoning for COMPLETENESS and FEASIBILITY relative to the user's original query.

Scoring rubric (1-5):
5 - Excellent: Plan fully addresses all aspects of the user query, identifies correct sequence of actions, considers edge cases.
4 - Good: Plan addresses most aspects correctly with minor gaps that won't affect execution.
3 - Acceptable: Plan captures the main intent but misses secondary requirements or has suboptimal ordering.
2 - Poor: Plan partially misinterprets the query or omits critical steps that will cause downstream failure.
1 - Fail: Plan fundamentally misunderstands the user's intent or is incoherent.

Instructions:
- First provide step-by-step reasoning explaining your assessment.
- Then output your score on a separate line as exactly: "Score: N" (where N is 1-5).
- Do NOT consider downstream execution results — evaluate the plan in isolation."#;

const SYSTEM_TOOLSEL: &str = r#"You are an expert evaluator assessing the quality of an AI agent's tool selection.

Evaluate whether the agent chose the CORRECT and RELEVANT tool for the task at hand, given the upstream context.

Scoring rubric (1-5):
5 - Excellent: Perfect tool choice — the most appropriate tool for this specific subtask.
4 - Good: Correct tool category, appropriate for the task with minor alternatives possible.
3 - Acceptable: Tool can accomplish the task but is not the optimal choice.
2 - Poor: Wrong tool category or clearly suboptimal choice that may cause issues.
1 - Fail: Completely wrong tool that cannot accomplish the intended subtask.

Instructions:
- First provide step-by-step reasoning explaining your assessment.
- Then output your score on a separate line as exactly: "Score: N" (where N is 1-5).
- Evaluate based on the context available at decision time, not hindsight."#;

const SYSTEM_PARAMGEN: &str = r#"You are an expert evaluator assessing the quality of parameters generated for a tool call.

Evaluate the CORRECTNESS and COMPLETENESS of the parameters passed to the selected tool.

Scoring rubric (1-5):
5 - Excellent: All parameters correct, complete, properly typed, and optimally configured.
4 - Good: Parameters correct and complete with minor style issues that won't affect execution.
3 - Acceptable: Parameters will work but have minor errors or missing optional fields.
2 - Poor: Parameters contain type errors, missing required fields, or incorrect values that may cause failure.
1 - Fail: Parameters are fundamentally wrong — wrong types, missing critical fields, or will definitely cause tool failure.

Instructions:
- First provide step-by-step reasoning explaining your assessment.
- Then output your score on a separate line as exactly: "Score: N" (where N is 1-5).
- Consider whether the parameters correctly implement the intended action from upstream context."#;

const SYSTEM_EXEC: &str = r#"You are an expert evaluator assessing the quality of a tool execution result.

Evaluate the SUCCESS and VALIDITY of the tool's output relative to what was requested.

Scoring rubric (1-5):
5 - Excellent: Tool executed successfully, returned complete and valid results.
4 - Good: Tool succeeded with minor limitations (e.g., partial results that still suffice).
3 - Acceptable: Tool returned results but with warnings or incomplete data.
2 - Poor: Tool returned an error or clearly invalid/empty results.
1 - Fail: Tool completely failed — timeout, crash, or returned data that contradicts the request.

Instructions:
- First provide step-by-step reasoning explaining your assessment.
- Then output your score on a separate line as exactly: "Score: N" (where N is 1-5).
- Note: An error response from the tool (e.g., "API key missing") should score 1-2 regardless of cause."#;

const SYSTEM_SYNTH: &str = r#"You are an expert evaluator assessing the quality of an AI agent's final synthesis/response.

Evaluate the response for FAITHFULNESS, COMPLETENESS, and COHERENCE relative to the upstream tool results and original user query.

Scoring rubric (1-5):
5 - Excellent: Response is fully faithful to tool outputs, completely addresses the user's query, and is clearly written.
4 - Good: Response is mostly accurate with minor omissions or phrasing issues.
3 - Acceptable: Response covers the main points but misses secondary details or has minor inaccuracies.
2 - Poor: Response contains hallucinated information not grounded in tool results, or significantly incomplete.
1 - Fail: Response is mostly fabricated, contradicts tool outputs, or fails to address the user's query.

Instructions:
- First provide step-by-step reasoning explaining your assessment.
- Then output your score on a separate line as exactly: "Score: N" (where N is 1-5).
- Pay special attention to FAITHFULNESS: any claim not supported by upstream results is a serious flaw."#;
