// ─────────────────────────────────────────────────────────────────────────────
// Metrics Types
// Complete KPI definitions for every orchestration layer.
// ─────────────────────────────────────────────────────────────────────────────

export interface GlobalMetrics {
  total_turns: number;
  successful_turns: number;
  failed_turns: number;
  avg_total_turn_latency_ms: number;
  p95_total_turn_latency_ms: number;
  sessions_created: number;
  active_sessions: number;
  completed_sessions: number;
  error_rate: number;
  fallback_rate: number;
}

export interface LlmMetrics {
  llm_calls_total: number;
  llm_success_total: number;
  llm_error_total: number;
  avg_llm_latency_ms: number;
  p95_llm_latency_ms: number;
  avg_prompt_tokens: number;
  avg_completion_tokens: number;
  total_estimated_cost: number;
  json_parse_failure_rate: number;
  structured_output_validation_failure_rate: number;
}

export interface ToolMetrics {
  tool_calls_total: number;
  tool_success_total: number;
  tool_error_total: number;
  avg_tool_latency_ms: number;
  p95_tool_latency_ms: number;
  tool_timeout_total: number;
  most_used_tools: Record<string, number>;
  tool_validation_failure_total: number;
}

export interface RuleMetrics {
  rules_checked_total: number;
  rule_violations_total: number;
  hard_rule_blocks_total: number;
  soft_rule_warnings_total: number;
  rule_violation_by_rule_id: Record<string, number>;
  avg_rule_check_latency_ms: number;
  // Reservation-specific
  customer_lead_time_blocks_total: number;
  same_day_min_duration_blocks_total: number;
  driver_age_blocks_total: number;
  closed_day_blocks_total: number;
  closed_special_day_blocks_total: number;
  terms_required_blocks_total: number;
  authentication_required_blocks_total: number;
  invalid_admin_manual_price_blocks_total: number;
}

export interface StateMetrics {
  sessions_loaded_total: number;
  sessions_created_total: number;
  sessions_updated_total: number;
  session_load_latency_ms: number;
  session_save_latency_ms: number;
  state_merge_conflicts_total: number;
  missing_field_count_avg: number;
  booking_completion_rate: number;
}

export interface WorkflowMetrics {
  workflow_step_transition_total: number;
  current_step_distribution: Record<string, number>;
  invalid_transition_total: number;
  avg_steps_to_ready_for_confirmation: number;
  workflow_completion_rate: number;
  step_repetition_count: number;
  repeated_question_count: number;
}

export interface MemoryMetrics {
  memory_reads_total: number;
  memory_writes_total: number;
  memory_read_latency_ms: number;
  memory_write_latency_ms: number;
  transcript_message_count_avg: number;
  memory_pruned_total: number;
  session_memory_size_avg: number;
}

export interface ContextMetrics {
  context_load_total: number;
  context_cache_hit_rate: number;
  context_cache_miss_rate: number;
  avg_context_load_latency_ms: number;
  context_empty_result_total: number;
  rag_queries_total: number;
  rag_hit_rate: number;
  avg_rag_latency_ms: number;
  retrieved_chunk_count_avg: number;
}

export interface GuardrailMetrics {
  guardrail_checks_total: number;
  guardrail_blocks_total: number;
  unsafe_response_blocks_total: number;
  invented_price_block_total: number;
  invented_office_block_total: number;
  invented_category_block_total: number;
  reservation_without_confirmation_block_total: number;
  avg_guardrail_latency_ms: number;
  // Reservation
  invalid_reservation_payload_block_total: number;
  reservation_rule_violation_block_total: number;
  invented_availability_block_total: number;
  reservation_created_without_auth_block_total: number;
  reservation_created_without_terms_block_total: number;
}

export interface ChannelMetrics {
  web_text_turns_total: number;
  web_voice_turns_total: number;
  websocket_connections_total: number;
  websocket_disconnects_total: number;
  audio_chunks_received_total: number;
  avg_audio_chunk_size_bytes: number;
  transcription_latency_ms: number;
  tts_latency_ms: number;
  barge_in_total: number;
  interruption_success_rate: number;
}

export interface EvaluationMetrics {
  turns_evaluated_total: number;
  extraction_accuracy_score_avg: number;
  rule_compliance_score_avg: number;
  task_progress_score_avg: number;
  response_quality_score_avg: number;
  human_handoff_recommended_total: number;
  failed_reason_distribution: Record<string, number>;
}

export interface PricingMetrics {
  price_calculation_total: number;
  price_calculation_success_total: number;
  price_calculation_error_total: number;
  avg_price_calculation_latency_ms: number;
  pricing_tier_fallback_total: number;
  automatic_gear_extra_applied_total: number;
  pickup_extension_price_applied_total: number;
  return_extension_price_applied_total: number;
  addon_price_applied_total: number;
  discount_applied_total: number;
  discount_rejected_total: number;
}

export interface AvailabilityMetrics {
  time_slot_generation_total: number;
  closed_date_detected_total: number;
  reserved_slot_conflict_total: number;
  exact_reserved_slot_block_total: number;
  overlap_check_not_enforced_warning_total: number;
}

export interface AllMetrics {
  global: GlobalMetrics;
  llm: LlmMetrics;
  tools: ToolMetrics;
  rules: RuleMetrics;
  state: StateMetrics;
  workflow: WorkflowMetrics;
  memory: MemoryMetrics;
  context: ContextMetrics;
  guardrails: GuardrailMetrics;
  channels: ChannelMetrics;
  evaluation: EvaluationMetrics;
  pricing: PricingMetrics;
  availability: AvailabilityMetrics;
}

// ─────────────────────────────────────────────────────────────────────────────
// TurnTrace — one record per agent turn
// ─────────────────────────────────────────────────────────────────────────────

export interface TurnTrace {
  turnId: string;
  sessionId: string;
  input: string;
  intent?: string;
  stateBefore: unknown;
  stateAfter: unknown;
  workflowStepBefore: string;
  workflowStepAfter: string;
  contextUsed: {
    officeCount: number;
    categoryCount: number;
    addOnCount: number;
    cacheHit: boolean;
  };
  llmCalls: Array<{
    model: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    purpose: "extraction" | "response" | "intent_classification";
    parseError?: string;
  }>;
  toolCalls: Array<{
    toolName: string;
    success: boolean;
    latencyMs: number;
    error?: string;
  }>;
  rulesChecked: Array<{
    ruleId: string;
    passed: boolean;
    severity: string;
  }>;
  guardrailsChecked: Array<{
    guardrailId: string;
    passed: boolean;
    blocked: boolean;
  }>;
  response: string;
  metrics: {
    totalMs: number;
    stateLoadMs: number;
    memoryReadMs: number;
    contextLoadMs: number;
    ruleCheckMs: number;
    llmMs: number;
    toolMs: number;
    guardrailMs: number;
    stateSaveMs: number;
  };
  errors: string[];
}
