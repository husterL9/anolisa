//! Hierarchical failure taxonomy (paper §3.3, Table 8).
//!
//! 3 levels × 21 subcategories derived from manual analysis of 523 agent traces.
//! Used to classify failures after a node scores below its threshold.

use serde::{Deserialize, Serialize};

/// A single entry in the failure taxonomy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaxonomyEntry {
    pub level1: &'static str,
    pub level2: &'static str,
    pub level3: &'static str,
    pub description: &'static str,
}

/// Complete taxonomy: 3 Level-1 → 9 Level-2 → 21 Level-3.
pub const TAXONOMY: &[TaxonomyEntry] = &[
    // ─── Planning ────────────────────────────────────────────────────────────────
    TaxonomyEntry {
        level1: "Planning",
        level2: "Goal misinterpretation",
        level3: "Scope error",
        description: "Agent addresses wrong aspect of the query",
    },
    TaxonomyEntry {
        level1: "Planning",
        level2: "Goal misinterpretation",
        level3: "Ambiguity failure",
        description: "Agent selects wrong interpretation without clarification",
    },
    TaxonomyEntry {
        level1: "Planning",
        level2: "Missing steps",
        level3: "Tool omission",
        description: "Required tool not included in plan",
    },
    TaxonomyEntry {
        level1: "Planning",
        level2: "Missing steps",
        level3: "Verification gap",
        description: "Plan lacks result verification",
    },
    TaxonomyEntry {
        level1: "Planning",
        level2: "Missing steps",
        level3: "Prerequisite skip",
        description: "Dependency step omitted",
    },
    TaxonomyEntry {
        level1: "Planning",
        level2: "Incorrect ordering",
        level3: "Dependency violation",
        description: "Step executed before prerequisites",
    },
    TaxonomyEntry {
        level1: "Planning",
        level2: "Incorrect ordering",
        level3: "Suboptimal sequence",
        description: "Valid but inefficient ordering",
    },
    // ─── Execution ───────────────────────────────────────────────────────────────
    TaxonomyEntry {
        level1: "Execution",
        level2: "Wrong tool selection",
        level3: "Category error",
        description: "Wrong tool category",
    },
    TaxonomyEntry {
        level1: "Execution",
        level2: "Wrong tool selection",
        level3: "Granularity mismatch",
        description: "Correct category but wrong specificity",
    },
    TaxonomyEntry {
        level1: "Execution",
        level2: "Parameter errors",
        level3: "Type mismatch",
        description: "Wrong data type",
    },
    TaxonomyEntry {
        level1: "Execution",
        level2: "Parameter errors",
        level3: "Value error",
        description: "Correct type but incorrect value",
    },
    TaxonomyEntry {
        level1: "Execution",
        level2: "Parameter errors",
        level3: "Missing required",
        description: "Required parameter omitted",
    },
    TaxonomyEntry {
        level1: "Execution",
        level2: "API/tool failures",
        level3: "Timeout",
        description: "Tool call exceeds time limit",
    },
    TaxonomyEntry {
        level1: "Execution",
        level2: "API/tool failures",
        level3: "Error response",
        description: "Tool returns error, agent fails to handle",
    },
    // ─── Integration ─────────────────────────────────────────────────────────────
    TaxonomyEntry {
        level1: "Integration",
        level2: "Context loss",
        level3: "Truncation",
        description: "Information dropped between steps",
    },
    TaxonomyEntry {
        level1: "Integration",
        level2: "Context loss",
        level3: "Selective omission",
        description: "Agent ignores relevant output parts",
    },
    TaxonomyEntry {
        level1: "Integration",
        level2: "Output hallucination",
        level3: "Fabrication",
        description: "Information not grounded in any result",
    },
    TaxonomyEntry {
        level1: "Integration",
        level2: "Output hallucination",
        level3: "Conflation",
        description: "Information from different steps incorrectly merged",
    },
    TaxonomyEntry {
        level1: "Integration",
        level2: "Premature termination",
        level3: "Partial completion",
        description: "Agent declares success prematurely",
    },
    TaxonomyEntry {
        level1: "Integration",
        level2: "Premature termination",
        level3: "Loop exit",
        description: "Agent exits retry loop too early",
    },
    // Note: Paper mentions 21 subcategories. This is 20 from Table 8.
    // The 21st is often added during deployment (see Appendix N governance protocol).
    // We add a catch-all for unclassifiable failures:
    TaxonomyEntry {
        level1: "Other",
        level2: "Unclassified",
        level3: "Unknown",
        description: "Failure does not clearly fit any existing category",
    },
];

/// Build the taxonomy classification prompt for a failed node.
/// The judge must pick exactly one taxonomy entry from the list.
pub fn build_taxonomy_prompt(
    node_type: &str,
    node_output: &str,
    upstream_context: &str,
    score: u8,
) -> String {
    let taxonomy_list = TAXONOMY
        .iter()
        .enumerate()
        .map(|(i, t)| {
            format!(
                "{}. [{}/{}] {} — {}",
                i + 1,
                t.level1,
                t.level2,
                t.level3,
                t.description
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"System:
You are an expert failure analyst for AI agent workflows.
A step of type "{node_type}" scored {score}/5, indicating a failure.
Your task: classify this failure into exactly ONE category from the taxonomy below.

Taxonomy:
{taxonomy_list}

Instructions:
- Analyze the step's output and context to determine the failure type.
- First explain your reasoning (2-3 sentences).
- Then output the classification on a separate line as exactly:
  "Classification: <number>" (where number is 1-{total})

User:
Step type: {node_type}
Score: {score}/5

Upstream context:
{upstream_context}

Step output (failed):
{node_output}

Classify this failure."#,
        node_type = node_type,
        score = score,
        taxonomy_list = taxonomy_list,
        total = TAXONOMY.len(),
        upstream_context = upstream_context,
        node_output = node_output,
    )
}

/// Parse a taxonomy classification response from the judge.
/// Returns the matched TaxonomyEntry index (0-based) or None.
pub fn parse_taxonomy_response(response: &str) -> Option<usize> {
    // Look for "Classification: N" pattern
    for line in response.lines().rev() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Classification:") {
            if let Ok(n) = rest.trim().parse::<usize>() {
                if n >= 1 && n <= TAXONOMY.len() {
                    return Some(n - 1); // 0-based
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_taxonomy_count() {
        assert_eq!(TAXONOMY.len(), 21);
    }

    #[test]
    fn test_parse_classification() {
        assert_eq!(parse_taxonomy_response("Reasoning...\nClassification: 7"), Some(6));
        assert_eq!(parse_taxonomy_response("Classification: 1"), Some(0));
        assert_eq!(parse_taxonomy_response("Classification: 21"), Some(20));
        assert_eq!(parse_taxonomy_response("Classification: 0"), None);
        assert_eq!(parse_taxonomy_response("no match here"), None);
    }
}
