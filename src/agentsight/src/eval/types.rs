//! Data types for the DAG evaluation engine (AgentEval Algorithm 1).
//!
//! Based on arXiv:2604.23581 §3.2-3.4:
//!   - Per-node quality scores via LLM-as-judge (1-5 rubric)
//!   - Hierarchical failure taxonomy (3 levels, 21 subcategories)
//!   - Root cause attribution via greedy heuristic

use serde::{Deserialize, Serialize};

// ─── Score thresholds (paper Table 17) ───────────────────────────────────────

/// Per-type failure thresholds. A score below these triggers failure classification.
pub const THRESHOLD_PLAN: u8 = 3;
pub const THRESHOLD_TOOLSEL: u8 = 3;
pub const THRESHOLD_PARAMGEN: u8 = 3; // Paper uses 2.5, we round to 3 for integer scoring
pub const THRESHOLD_EXEC: u8 = 3;
pub const THRESHOLD_SYNTH: u8 = 3;

/// Get the failure threshold for a given node type.
pub fn threshold_for_type(node_type: &str) -> u8 {
    match node_type {
        "PLAN" => THRESHOLD_PLAN,
        "TOOLSEL" => THRESHOLD_TOOLSEL,
        "PARAMGEN" => THRESHOLD_PARAMGEN,
        "EXEC" => THRESHOLD_EXEC,
        "SYNTH" => THRESHOLD_SYNTH,
        _ => 3, // default
    }
}

// ─── Node evaluation result ──────────────────────────────────────────────────

/// How a failed node relates to the error chain.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "source")]
pub enum Attribution {
    /// Node scored above threshold — no failure.
    Pass,
    /// This node is the origin of the failure chain (no failed parents).
    RootCause,
    /// Failure propagated from a parent node (carries the parent's node_id).
    PropagatedFrom(String),
}

/// Three-level failure classification (paper Table 8).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureClass {
    /// Level 1: "Planning" / "Execution" / "Integration"
    pub level1: String,
    /// Level 2: e.g. "Context loss", "Wrong tool selection"
    pub level2: String,
    /// Level 3: e.g. "Truncation", "Category error"
    pub level3: String,
    /// Short description of why this classification was chosen.
    pub explanation: String,
}

/// Evaluation result for a single DAG node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeEvalResult {
    /// DAG node id (e.g. "s3.plan", "s3.toolsel.exec#1")
    pub node_id: String,
    /// Node type (PLAN/TOOLSEL/PARAMGEN/EXEC/SYNTH)
    pub node_type: String,
    /// Quality score 1-5 assigned by the LLM judge.
    pub score: u8,
    /// Chain-of-thought reasoning from the judge.
    pub reasoning: String,
    /// Whether score is below the type-specific threshold.
    pub is_failure: bool,
    /// Failure classification (only set when is_failure = true).
    pub failure_class: Option<FailureClass>,
    /// Root cause attribution.
    pub attribution: Attribution,
}

// ─── Evaluation report (per session) ─────────────────────────────────────────

/// Status of an evaluation run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum EvalStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

impl EvalStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            _ => Self::Pending,
        }
    }
}

/// Aggregate summary metrics for the whole evaluation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalSummary {
    pub total_nodes: usize,
    pub evaluated_nodes: usize,
    pub avg_score: f64,
    pub failure_count: usize,
    pub root_cause_count: usize,
    pub propagated_count: usize,
}

/// Complete evaluation report for a session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalReport {
    /// Unique id for this evaluation run.
    pub eval_id: String,
    /// Which session was evaluated.
    pub session_id: String,
    /// Judge model used.
    pub judge_model: String,
    /// Unix timestamp (seconds) when evaluation was created.
    pub created_at: i64,
    /// Unix timestamp when evaluation completed (0 if not yet).
    pub completed_at: i64,
    /// Current status.
    pub status: EvalStatus,
    /// Per-node results (empty until completed).
    pub nodes: Vec<NodeEvalResult>,
    /// Aggregate summary (computed on completion).
    pub summary: Option<EvalSummary>,
    /// Error message if status = Failed.
    pub error: Option<String>,
}

// ─── DAG structures for backend evaluation ───────────────────────────────────

/// Lightweight DAG node for backend evaluation (mirrors frontend DagNode).
#[derive(Debug, Clone)]
pub struct EvalDagNode {
    pub id: String,
    pub node_type: String,
    pub step_id: u32,
    pub label: String,
    /// Full content for judge evaluation (not truncated like frontend preview).
    pub content: String,
    pub tool_call_id: Option<String>,
    pub function_name: Option<String>,
    /// The user query this node should be evaluated against (for PLAN/SYNTH anchor).
    pub user_query: String,
}

/// DAG edge for backend evaluation.
#[derive(Debug, Clone)]
pub struct EvalDagEdge {
    pub from: String,
    pub to: String,
}

/// Complete DAG structure for evaluation.
#[derive(Debug, Clone)]
pub struct EvalDag {
    pub nodes: Vec<EvalDagNode>,
    pub edges: Vec<EvalDagEdge>,
    /// User query text (used as PLAN evaluation anchor).
    pub user_query: String,
}
