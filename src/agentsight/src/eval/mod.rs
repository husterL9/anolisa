//! DAG Evaluation Engine — implements AgentEval Algorithm 1 (arXiv:2604.23581).
//!
//! Components:
//!   - types:     Data structures for evaluation results, reports, and DAG nodes
//!   - rubrics:   Per-type LLM-as-judge prompt templates (§3.2)
//!   - taxonomy:  Hierarchical failure classification (§3.3, Table 8)
//!   - judge:     LLM API call wrapper (DashScope/OpenAI-compatible)
//!   - dag_parser: Rust-native DAG construction from ATIF (mirrors frontend dagParser.ts)
//!   - evaluator: Algorithm 1 main loop (topological sort → score → classify → attribute)

pub mod types;
pub mod rubrics;
pub mod taxonomy;
pub mod judge;
pub mod dag_parser;
pub mod evaluator;
