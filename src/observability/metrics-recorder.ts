import type {
  AllMetrics,
  TurnTrace,
  GlobalMetrics,
  LlmMetrics,
  ToolMetrics,
  RuleMetrics,
  WorkflowMetrics,
  GuardrailMetrics,
  ChannelMetrics,
  EvaluationMetrics,
  PricingMetrics,
  AvailabilityMetrics,
  StateMetrics,
  MemoryMetrics,
  ContextMetrics,
} from "./metrics.types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Metrics Recorder
// In-memory implementation. Replace with MongoDB/Prometheus/OTEL adapter later
// by swapping the underlying store while keeping this interface.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TRACES = 500; // circular buffer
const turnLatencies: number[] = [];
const llmLatencies: number[] = [];
const toolLatencies: number[] = [];
const guardrailLatencies: number[] = [];
const traces: TurnTrace[] = [];

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw counters
// ─────────────────────────────────────────────────────────────────────────────

const counters = {
  // Global
  total_turns: 0,
  successful_turns: 0,
  failed_turns: 0,
  sessions_created: 0,
  completed_sessions: 0,
  fallback_turns: 0,

  // LLM
  llm_calls: 0,
  llm_success: 0,
  llm_error: 0,
  llm_prompt_tokens: 0,
  llm_completion_tokens: 0,
  llm_json_parse_failures: 0,
  llm_validation_failures: 0,

  // Tools
  tool_calls: 0,
  tool_success: 0,
  tool_error: 0,
  tool_timeout: 0,
  tool_validation_failures: 0,
  tool_usage: {} as Record<string, number>,

  // Rules
  rules_checked: 0,
  rule_violations: 0,
  hard_blocks: 0,
  soft_warnings: 0,
  rule_by_id: {} as Record<string, number>,
  customer_lead_time_blocks: 0,
  same_day_blocks: 0,
  driver_age_blocks: 0,
  closed_day_blocks: 0,
  closed_special_day_blocks: 0,
  terms_blocks: 0,
  auth_blocks: 0,
  admin_manual_price_blocks: 0,

  // State
  sessions_loaded: 0,
  state_sessions_created: 0,
  sessions_updated: 0,
  state_conflicts: 0,
  completed_bookings: 0,

  // Workflow
  step_transitions: 0,
  invalid_transitions: 0,
  step_repetitions: 0,
  repeated_questions: 0,
  step_distribution: {} as Record<string, number>,
  steps_to_confirmation: [] as number[],
  completed_workflows: 0,

  // Memory
  memory_reads: 0,
  memory_writes: 0,
  memory_pruned: 0,

  // Context
  context_loads: 0,
  context_cache_hits: 0,
  context_cache_misses: 0,
  context_empty: 0,
  rag_queries: 0,
  rag_hits: 0,

  // Guardrails
  guardrail_checks: 0,
  guardrail_blocks: 0,
  invented_price_blocks: 0,
  invented_office_blocks: 0,
  invented_category_blocks: 0,
  reservation_no_confirm_blocks: 0,
  invalid_payload_blocks: 0,
  reservation_rule_blocks: 0,
  invented_availability_blocks: 0,
  no_auth_blocks: 0,
  no_terms_blocks: 0,

  // Channels
  web_text_turns: 0,
  web_voice_turns: 0,
  ws_connections: 0,
  ws_disconnects: 0,
  audio_chunks: 0,
  audio_chunk_bytes: 0,
  barge_ins: 0,
  interruptions_successful: 0,
  total_interruptions: 0,

  // Evaluation
  turns_evaluated: 0,
  extraction_scores: [] as number[],
  rule_compliance_scores: [] as number[],
  task_progress_scores: [] as number[],
  response_quality_scores: [] as number[],
  human_handoffs: 0,
  failed_reasons: {} as Record<string, number>,

  // Pricing
  price_calculations: 0,
  price_success: 0,
  price_errors: 0,
  pricing_tier_fallbacks: 0,
  auto_gear_extras: 0,
  pickup_extensions: 0,
  return_extensions: 0,
  addon_prices: 0,
  discounts_applied: 0,
  discounts_rejected: 0,

  // Availability
  time_slot_generations: 0,
  closed_dates_detected: 0,
  reserved_slot_conflicts: 0,
  exact_slot_blocks: 0,
  overlap_warnings: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Public recording API
// ─────────────────────────────────────────────────────────────────────────────

export function recordTurn(opts: {
  success: boolean;
  latencyMs: number;
  isFallback?: boolean;
}): void {
  counters.total_turns++;
  if (opts.success) counters.successful_turns++;
  else counters.failed_turns++;
  if (opts.isFallback) counters.fallback_turns++;
  turnLatencies.push(opts.latencyMs);
  if (turnLatencies.length > MAX_TRACES) turnLatencies.shift();
}

export function recordLlmCall(opts: {
  success: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  parseFailure?: boolean;
  validationFailure?: boolean;
}): void {
  counters.llm_calls++;
  if (opts.success) counters.llm_success++;
  else counters.llm_error++;
  llmLatencies.push(opts.latencyMs);
  if (llmLatencies.length > MAX_TRACES) llmLatencies.shift();
  counters.llm_prompt_tokens += opts.promptTokens;
  counters.llm_completion_tokens += opts.completionTokens;
  if (opts.parseFailure) counters.llm_json_parse_failures++;
  if (opts.validationFailure) counters.llm_validation_failures++;
}

export function recordToolCall(opts: {
  toolName: string;
  success: boolean;
  latencyMs: number;
  timeout?: boolean;
}): void {
  counters.tool_calls++;
  if (opts.success) counters.tool_success++;
  else counters.tool_error++;
  if (opts.timeout) counters.tool_timeout++;
  toolLatencies.push(opts.latencyMs);
  if (toolLatencies.length > MAX_TRACES) toolLatencies.shift();
  counters.tool_usage[opts.toolName] =
    (counters.tool_usage[opts.toolName] ?? 0) + 1;
}

export function recordRuleCheck(opts: {
  ruleId: string;
  passed: boolean;
  severity: "hard" | "soft";
}): void {
  counters.rules_checked++;
  if (!opts.passed) {
    counters.rule_violations++;
    if (opts.severity === "hard") counters.hard_blocks++;
    else counters.soft_warnings++;
    counters.rule_by_id[opts.ruleId] =
      (counters.rule_by_id[opts.ruleId] ?? 0) + 1;
    // Map specific rules to specific counters
    switch (opts.ruleId) {
      case "CUSTOMER_LEAD_TIME": counters.customer_lead_time_blocks++; break;
      case "SAME_DAY_MIN_DURATION": counters.same_day_blocks++; break;
      case "DRIVER_AGE": counters.driver_age_blocks++; break;
      case "AUTHENTICATION_REQUIRED": counters.auth_blocks++; break;
      case "ADMIN_MANUAL_PRICE": counters.admin_manual_price_blocks++; break;
    }
  }
}

export function recordGuardrailCheck(opts: {
  guardrailId: string;
  passed: boolean;
  blocked: boolean;
}): void {
  counters.guardrail_checks++;
  if (!opts.passed) {
    if (opts.blocked) counters.guardrail_blocks++;
    switch (opts.guardrailId) {
      case "INVENTED_PRICE_GUARD": counters.invented_price_blocks++; break;
      case "INVENTED_OFFICE_GUARD": counters.invented_office_blocks++; break;
      case "RESERVATION_WITHOUT_CONFIRMATION_GUARD":
        counters.reservation_no_confirm_blocks++; break;
    }
  }
}

export function recordWorkflowStep(step: string): void {
  counters.step_transitions++;
  counters.step_distribution[step] =
    (counters.step_distribution[step] ?? 0) + 1;
}

export function recordContextLoad(cacheHit: boolean): void {
  counters.context_loads++;
  if (cacheHit) counters.context_cache_hits++;
  else counters.context_cache_misses++;
}

export function recordSessionCreated(): void {
  counters.sessions_created++;
  counters.state_sessions_created++;
}

export function recordChannelTurn(channel: "text" | "voice"): void {
  if (channel === "text") counters.web_text_turns++;
  else counters.web_voice_turns++;
}

export function recordPriceCalculation(success: boolean, isFallback?: boolean): void {
  counters.price_calculations++;
  if (success) counters.price_success++;
  else counters.price_errors++;
  if (isFallback) counters.pricing_tier_fallbacks++;
}

export function recordHumanHandoff(): void {
  counters.human_handoffs++;
}

export function recordTrace(trace: TurnTrace): void {
  traces.push(trace);
  if (traces.length > MAX_TRACES) traces.shift();
}

export function getTrace(turnId: string): TurnTrace | undefined {
  return traces.find((t) => t.turnId === turnId);
}

export function getRecentTraces(limit = 10): TurnTrace[] {
  return traces.slice(-limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate snapshot
// ─────────────────────────────────────────────────────────────────────────────

export function getMetrics(): AllMetrics {
  const gpt4oMiniCostPer1kTokens = 0.000150; // approximation

  return {
    global: {
      total_turns: counters.total_turns,
      successful_turns: counters.successful_turns,
      failed_turns: counters.failed_turns,
      avg_total_turn_latency_ms: avg(turnLatencies),
      p95_total_turn_latency_ms: p95(turnLatencies),
      sessions_created: counters.sessions_created,
      active_sessions: 0, // populated by caller with stateManager.stats()
      completed_sessions: counters.completed_sessions,
      error_rate:
        counters.total_turns > 0
          ? counters.failed_turns / counters.total_turns
          : 0,
      fallback_rate:
        counters.total_turns > 0
          ? counters.fallback_turns / counters.total_turns
          : 0,
    },
    llm: {
      llm_calls_total: counters.llm_calls,
      llm_success_total: counters.llm_success,
      llm_error_total: counters.llm_error,
      avg_llm_latency_ms: avg(llmLatencies),
      p95_llm_latency_ms: p95(llmLatencies),
      avg_prompt_tokens:
        counters.llm_calls > 0
          ? counters.llm_prompt_tokens / counters.llm_calls
          : 0,
      avg_completion_tokens:
        counters.llm_calls > 0
          ? counters.llm_completion_tokens / counters.llm_calls
          : 0,
      total_estimated_cost:
        ((counters.llm_prompt_tokens + counters.llm_completion_tokens) /
          1000) *
        gpt4oMiniCostPer1kTokens,
      json_parse_failure_rate:
        counters.llm_calls > 0
          ? counters.llm_json_parse_failures / counters.llm_calls
          : 0,
      structured_output_validation_failure_rate:
        counters.llm_calls > 0
          ? counters.llm_validation_failures / counters.llm_calls
          : 0,
    },
    tools: {
      tool_calls_total: counters.tool_calls,
      tool_success_total: counters.tool_success,
      tool_error_total: counters.tool_error,
      avg_tool_latency_ms: avg(toolLatencies),
      p95_tool_latency_ms: p95(toolLatencies),
      tool_timeout_total: counters.tool_timeout,
      most_used_tools: counters.tool_usage,
      tool_validation_failure_total: counters.tool_validation_failures,
    },
    rules: {
      rules_checked_total: counters.rules_checked,
      rule_violations_total: counters.rule_violations,
      hard_rule_blocks_total: counters.hard_blocks,
      soft_rule_warnings_total: counters.soft_warnings,
      rule_violation_by_rule_id: counters.rule_by_id,
      avg_rule_check_latency_ms: 0,
      customer_lead_time_blocks_total: counters.customer_lead_time_blocks,
      same_day_min_duration_blocks_total: counters.same_day_blocks,
      driver_age_blocks_total: counters.driver_age_blocks,
      closed_day_blocks_total: counters.closed_day_blocks,
      closed_special_day_blocks_total: counters.closed_special_day_blocks,
      terms_required_blocks_total: counters.terms_blocks,
      authentication_required_blocks_total: counters.auth_blocks,
      invalid_admin_manual_price_blocks_total: counters.admin_manual_price_blocks,
    },
    state: {
      sessions_loaded_total: counters.sessions_loaded,
      sessions_created_total: counters.state_sessions_created,
      sessions_updated_total: counters.sessions_updated,
      session_load_latency_ms: 0,
      session_save_latency_ms: 0,
      state_merge_conflicts_total: counters.state_conflicts,
      missing_field_count_avg: 0,
      booking_completion_rate:
        counters.state_sessions_created > 0
          ? counters.completed_bookings / counters.state_sessions_created
          : 0,
    },
    workflow: {
      workflow_step_transition_total: counters.step_transitions,
      current_step_distribution: counters.step_distribution,
      invalid_transition_total: counters.invalid_transitions,
      avg_steps_to_ready_for_confirmation: avg(counters.steps_to_confirmation),
      workflow_completion_rate:
        counters.state_sessions_created > 0
          ? counters.completed_workflows / counters.state_sessions_created
          : 0,
      step_repetition_count: counters.step_repetitions,
      repeated_question_count: counters.repeated_questions,
    },
    memory: {
      memory_reads_total: counters.memory_reads,
      memory_writes_total: counters.memory_writes,
      memory_read_latency_ms: 0,
      memory_write_latency_ms: 0,
      transcript_message_count_avg: 0,
      memory_pruned_total: counters.memory_pruned,
      session_memory_size_avg: 0,
    },
    context: {
      context_load_total: counters.context_loads,
      context_cache_hit_rate:
        counters.context_loads > 0
          ? counters.context_cache_hits / counters.context_loads
          : 0,
      context_cache_miss_rate:
        counters.context_loads > 0
          ? counters.context_cache_misses / counters.context_loads
          : 0,
      avg_context_load_latency_ms: 0,
      context_empty_result_total: counters.context_empty,
      rag_queries_total: counters.rag_queries,
      rag_hit_rate: 0,
      avg_rag_latency_ms: 0,
      retrieved_chunk_count_avg: 0,
    },
    guardrails: {
      guardrail_checks_total: counters.guardrail_checks,
      guardrail_blocks_total: counters.guardrail_blocks,
      unsafe_response_blocks_total: counters.guardrail_blocks,
      invented_price_block_total: counters.invented_price_blocks,
      invented_office_block_total: counters.invented_office_blocks,
      invented_category_block_total: counters.invented_category_blocks,
      reservation_without_confirmation_block_total:
        counters.reservation_no_confirm_blocks,
      avg_guardrail_latency_ms: avg(guardrailLatencies),
      invalid_reservation_payload_block_total: counters.invalid_payload_blocks,
      reservation_rule_violation_block_total: counters.reservation_rule_blocks,
      invented_availability_block_total: counters.invented_availability_blocks,
      reservation_created_without_auth_block_total: counters.no_auth_blocks,
      reservation_created_without_terms_block_total: counters.no_terms_blocks,
    },
    channels: {
      web_text_turns_total: counters.web_text_turns,
      web_voice_turns_total: counters.web_voice_turns,
      websocket_connections_total: counters.ws_connections,
      websocket_disconnects_total: counters.ws_disconnects,
      audio_chunks_received_total: counters.audio_chunks,
      avg_audio_chunk_size_bytes:
        counters.audio_chunks > 0
          ? counters.audio_chunk_bytes / counters.audio_chunks
          : 0,
      transcription_latency_ms: 0,
      tts_latency_ms: 0,
      barge_in_total: counters.barge_ins,
      interruption_success_rate:
        counters.total_interruptions > 0
          ? counters.interruptions_successful / counters.total_interruptions
          : 0,
    },
    evaluation: {
      turns_evaluated_total: counters.turns_evaluated,
      extraction_accuracy_score_avg: avg(counters.extraction_scores),
      rule_compliance_score_avg: avg(counters.rule_compliance_scores),
      task_progress_score_avg: avg(counters.task_progress_scores),
      response_quality_score_avg: avg(counters.response_quality_scores),
      human_handoff_recommended_total: counters.human_handoffs,
      failed_reason_distribution: counters.failed_reasons,
    },
    pricing: {
      price_calculation_total: counters.price_calculations,
      price_calculation_success_total: counters.price_success,
      price_calculation_error_total: counters.price_errors,
      avg_price_calculation_latency_ms: 0,
      pricing_tier_fallback_total: counters.pricing_tier_fallbacks,
      automatic_gear_extra_applied_total: counters.auto_gear_extras,
      pickup_extension_price_applied_total: counters.pickup_extensions,
      return_extension_price_applied_total: counters.return_extensions,
      addon_price_applied_total: counters.addon_prices,
      discount_applied_total: counters.discounts_applied,
      discount_rejected_total: counters.discounts_rejected,
    },
    availability: {
      time_slot_generation_total: counters.time_slot_generations,
      closed_date_detected_total: counters.closed_dates_detected,
      reserved_slot_conflict_total: counters.reserved_slot_conflicts,
      exact_reserved_slot_block_total: counters.exact_slot_blocks,
      overlap_check_not_enforced_warning_total: counters.overlap_warnings,
    },
  };
}
