# AgentSight DAG 评估框架实现总结

> 基于论文 AgentEval (arXiv:2604.23581) 的 DAG 结构化步骤级评估方法，在 AgentSight 中完整落地了 Algorithm 1 评估引擎。

## 一、背景与动机

传统的 Agent 评估依赖端到端结果检查（pass/fail），无法定位中间步骤的失败根因。AgentEval 论文提出将 Agent 执行轨迹形式化为**评估 DAG**（有向无环图），每个节点携带类型化质量指标，通过 LLM-as-judge 逐节点评分 + 失败传播追踪，实现：

- 2.17x 高于端到端评估的失败检测召回率
- 72% 根因归因准确率（人类上限 81%）
- 中位根因定位时间从 4.2 小时降至 22 分钟

## 二、整体架构

```
┌─ 前端 Dashboard ─────────────────────┐    ┌─ 后端 Rust ────────────────────────────────┐
│                                       │    │                                            │
│  ATIF 查看器                          │    │  POST /api/eval/session/{id}               │
│  ├─ DAG 鸟瞰图（含评分色块叠加）      │    │    ├─ 1. 加载 ATIF (converter.rs)           │
│  ├─ 诊断详情面板（三档分级）          │    │    ├─ 2. 构建 DAG (eval/dag_parser.rs)      │
│  ├─ "运行评估" 按钮                   │    │    ├─ 3. 拓扑排序 (Kahn's algorithm)        │
│  └─ 右侧节点评分面板                  │    │    ├─ 4. 逐节点 LLM Judge 评分             │
│      (sticky, 颜色编码, 根因标签)     │    │    ├─ 5. 失败分类 (21类 Taxonomy)           │
│                                       │    │    ├─ 6. 根因归因 (贪心启发式)              │
│                                       │    │    └─ 7. 返回 EvalReport JSON              │
└───────────────────────────────────────┘    └────────────────────────────────────────────┘
```

## 三、已实现功能清单

### 3.1 DAG 构图（Parser）

| 能力 | 实现位置 | 说明 |
|------|----------|------|
| Trace-inferred DAG 构建 | 前端 `dagParser.ts` + 后端 `eval/dag_parser.rs` | 从 ATIF 步骤自动推断 DAG 结构 |
| 5+2 种节点类型 | PLAN / TOOLSEL / PARAMGEN / EXEC / SYNTH + SYSTEM / USER_QUERY | 论文 §3.1 定义 |
| 4 种边类型 | intra_step / inter_step / tool_link / fallback_seq | 含显式工具绑定 + 兜底顺序 |
| Loop Unrolling | 同 step 内同名工具重复调用自动展开，节点 id 加 `#k` 后缀 | 论文 Appendix A |
| ID 归一化匹配 | 后端 tool_call_id 下划线不一致问题的前端兜底 | 去 `_`/`-`/空格后重匹配 |
| 拓扑排序 | Kahn's algorithm (Rust 版) | 保证评估按依赖顺序进行 |

### 3.2 LLM-as-Judge 评分（论文 §3.2）

| 能力 | 实现位置 | 说明 |
|------|----------|------|
| 5 种类型专用 Rubric | `eval/rubrics.rs` | 每种类型独立的 system prompt + 1-5 评分标准 |
| 评分锚点差异化 | PLAN 对标用户原始问题；其他类型对标上游节点输出 | 论文核心设计 |
| Chain-of-thought 要求 | Rubric 要求 judge 先推理再打分 | 提高评分可解释性 |
| Score 解析 | 从响应末尾提取 `Score: N` | 鲁棒解析 + fallback 默认 3 分 |
| Judge 模型 | qwen-max（百炼 DashScope） | 与被评 agent (qwen-plus/qwq-plus) 不同系列 |

### 3.3 失败分类（论文 §3.3, Table 8）

#### 触发条件

失败分类**不是每个节点都会执行**的，它是一个条件触发的第二次 LLM 调用：

```
节点评分 score < threshold  →  触发失败分类
节点评分 score >= threshold →  直接标记 Pass，不分类
```

各类型阈值（论文 Table 17）：
| 节点类型 | 阈值 θ | 含义 |
|----------|--------|------|
| PLAN | 3 | 小于 3 分则视为规划失败 |
| TOOLSEL | 3 | 小于 3 分则视为工具选择失败 |
| PARAMGEN | 3 | 小于 3 分则视为参数生成失败 |
| EXEC | 3 | 小于 3 分则视为执行失败 |
| SYNTH | 3 | 小于 3 分则视为综合回复失败 |

#### 分类流程

```
1. 节点评分完成，发现 score < θ
2. 构造分类 prompt：
   - 把 21 类完整列表传给 judge
   - 附带节点类型、输出内容、上游上下文、得分
   - 要求 judge 从 21 类中选择最匹配的 1 类
3. 发送给 qwen-max，解析返回的 "Classification: N"
4. 映射到对应的 level1/level2/level3 三元组
```

#### 完整 21 类分类表

| Level 1 | Level 2 | Level 3 | 描述 |
|---------|---------|---------|------|
| **Planning** | Goal misinterpretation | Scope error | Agent 回答了用户问题的错误方面 |
| Planning | Goal misinterpretation | Ambiguity failure | 未向用户澄清歧义，直接选了错误理解 |
| Planning | Missing steps | Tool omission | 计划中遗漏了必需的工具调用 |
| Planning | Missing steps | Verification gap | 计划缺少结果验证步骤 |
| Planning | Missing steps | Prerequisite skip | 跳过了前置依赖步骤 |
| Planning | Incorrect ordering | Dependency violation | 步骤在前置条件完成前就执行了 |
| Planning | Incorrect ordering | Suboptimal sequence | 顺序正确但不是最优（可能导致重复调用） |
| **Execution** | Wrong tool selection | Category error | 选了完全错误类别的工具 |
| Execution | Wrong tool selection | Granularity mismatch | 工具类别正确但粒度不匹配 |
| Execution | Parameter errors | Type mismatch | 参数类型错误 |
| Execution | Parameter errors | Value error | 类型正确但值错误 |
| Execution | Parameter errors | Missing required | 必填参数缺失 |
| Execution | API/tool failures | Timeout | 工具调用超时 |
| Execution | API/tool failures | Error response | 工具返回错误（如 API key 缺失、网络异常） |
| **Integration** | Context loss | Truncation | 步骤间信息被截断/丢失 |
| Integration | Context loss | Selective omission | Agent 忽略了上游输出的关键部分 |
| Integration | Output hallucination | Fabrication | 回复中包含未基于任何工具结果的虚构信息 |
| Integration | Output hallucination | Conflation | 错误地合并了不同步骤的信息 |
| Integration | Premature termination | Partial completion | Agent 过早宣布完成，实际未全部完成 |
| Integration | Premature termination | Loop exit | Agent 过早退出重试循环 |
| **Other** | Unclassified | Unknown | 不属于以上任何类别的失败 |

#### 分类与归因的关系

失败分类和根因归因是**两个独立的步骤**：

```
                    节点评分 (score)
                         │
                    score < θ ?
                    ┌───┼───┐
                   Yes        No → Pass，结束
                    │
        ┌───────┼───────┐
        │                       │
  失败分类 (Taxonomy)     根因归因 (Attribution)
  “这是什么类型的失败”    “这个失败是谁引起的”
        │                       │
   第二次 LLM 调用         检查父节点 score
   返回: L1/L2/L3           父也失败 → PropagatedFrom
                            父未失败 → RootCause
```

两者配合能回答两个核心问题：
- **分类**回答：“出了什么问题？”（例：API key 缺失 → Execution / API/tool failures / Error response）
- **归因**回答：“谁导致的？”（例：这个 EXEC 失败是根因，下游 SYNTH 是从它传播来的）

#### 实际例子（本次验证数据）

```
节点: s3.exec.2
评分: 1/5 (低于阈值 3)

→ 触发失败分类:
  Level 1: Execution
  Level 2: API/tool failures  
  Level 3: Error response
  原因: web_search 工具因缺少 KIMI_API_KEY 返回错误

→ 触发根因归因:
  父节点 s3.paramgen.2 得分 5 (未失败)
  ∴ s3.exec.2 被标记为 RootCause

下游传播:
  s3.synth 得分 1 (也失败)
  其父节点 s3.exec.2 已失败 (score=1 < θ=3)
  ∴ s3.synth 被标记为 PropagatedFrom(s3.exec.2)
  分类: Integration / Context loss / Selective omission
  原因: 因上游工具失败，回复无法完整覆盖用户问题
```

### 3.4 根因归因（Algorithm 1 核心）

```
对每个失败节点 v_i:
  if 存在父节点 v_j 也失败:
    选 score 最低的父节点 v_j* 作为传播源
    标记 v_i 为 "PropagatedFrom(v_j*)"
  else:
    标记 v_i 为 "RootCause"
```

实际验证结果（session `194ed800...`）：
- **62 个节点**被评估
- **17 个失败**（score < 3）
- **12 个根因**（主要是 web_search API key 缺失导致的 EXEC 失败）
- **5 个传播**（从 EXEC 失败传播到下游 SYNTH）

### 3.5 可视化展示

| 组件 | 功能 |
|------|------|
| DAG 鸟瞰图 | 节点按评分颜色编码边框（绿=4-5, 黄=3, 红=1-2） |
| 诊断详情面板 | 三档色标（INFO/WARN/ERROR）+ 点击跳转高亮 |
| 评分摘要卡 | 均分、失败数、根因数 |
| 右侧评分面板 | sticky 定位，每节点一张卡，含 score/type/attribution/taxonomy |
| 边类型图例 | 4 种边样式 + 中文标签 |

## 四、技术实现统计

### 新增文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/eval/mod.rs` | 17 | 模块入口 |
| `src/eval/types.rs` | 172 | 数据结构 |
| `src/eval/rubrics.rs` | 156 | 评分 prompt 模板 |
| `src/eval/taxonomy.rs` | 247 | 失败分类定义 |
| `src/eval/judge.rs` | 149 | LLM API 调用封装 |
| `src/eval/dag_parser.rs` | 218 | Rust 版 DAG 解析 |
| `src/eval/evaluator.rs` | 232 | Algorithm 1 主流程 |
| `dashboard/src/types/dag.ts` | 95 | 前端 DAG 类型 |
| `dashboard/src/utils/dagParser.ts` | ~450 | 前端 DAG 解析 |
| `dashboard/src/components/DagOverview.tsx` | ~600 | DAG 可视化 + 诊断面板 |
| `dashboard/src/test/dagParser.test.ts` | ~280 | 11 个单元测试 |
| **合计** | **~2600+** | |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/lib.rs` | +1 行（注册 eval 模块） |
| `src/server/handlers.rs` | +75 行（POST /api/eval/session 接口） |
| `src/server/mod.rs` | +2 行（路由注册） |
| `src/genai/id_resolver.rs` | 1 行注释修正 |
| `src/genai/builder.rs` | 4 行注释修正 |
| `dashboard/src/pages/AtifViewerPage.tsx` | +80 行（评估按钮 + 右侧面板） |
| `dashboard/src/utils/apiClient.ts` | +43 行（eval API 类型 + 调用函数） |

## 五、端到端验证结果

使用 OpenClaw (qwen-plus + qwq-plus) 真实 agent trace：

```
eval_id:       eval-6a31846c-6880
session_id:    194ed800-6a49-4414-923e-dee1104e9b8f
judge_model:   qwen-max
duration:      524s (8.7 分钟)
total_nodes:   62
avg_score:     3.39/5
failures:      17 (27.4%)
root_causes:   12
propagated:    5
```

典型根因链示例：
```
s3.exec.2 [EXEC] score=1 → RootCause [API/tool failures / Error response]
  ↓ 传播
s3.synth  [SYNTH] score=1 → PropagatedFrom(s3.exec.2) [Context loss / Selective omission]
```

评估引擎正确识别了 web_search 工具因缺少 KIMI_API_KEY 导致的级联失败。

## 六、与论文对标

| 论文组件 | 实现状态 | 备注 |
|----------|----------|------|
| Evaluation DAG (§3.1) | ✅ 完整 | trace-inferred + loop unrolling + fallback |
| Step-Level Metrics (§3.2) | ✅ 完整 | 5 种 rubric + CoT + 差异化锚点 |
| Failure Taxonomy (§3.3) | ✅ 完整 | 3 级 21 类 |
| Root Cause Attribution | ✅ 完整 | 贪心启发式 |
| Automated Regression Suite (§3.4) | ❌ 未做 | CI/CD 集成待后续 |
| Schema-defined DAG | ❌ 未做 | 仅 trace-inferred |
| Cross-model Judge 对比 | ❌ 未做 | 目前仅 qwen-max |

## 七、后续可扩展方向

1. **异步评估队列**：当前同步阻塞（~9 分钟），改为后台任务 + 轮询进度
2. **评估结果持久化**：写入 SQLite，支持历史对比和回归检测
3. **CI/CD 集成**：论文 §3.4 的回归测试套件
4. **Few-shot 校准**：为每个 rubric 加 5 个分数梯度样例
5. **多模型 Judge 对比**：GPT-4o / Claude 3.5 作为 cross-check
6. **前端交互增强**：点击节点展开详细 reasoning + taxonomy 解释

---

*文档生成时间：2026-06-17*
*分支：feature/sight/dag-evaluation*
*基于论文：AgentEval: DAG-Structured Step-Level Evaluation for Agentic Workflows with Error Propagation Tracking (ACL 2026 Industry Track)*
