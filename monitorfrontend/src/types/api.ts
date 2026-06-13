// ── Booking Draft ────────────────────────────────────────────────────────────
export interface PricePreview {
  totalPrice: number
  currency: 'GBP'
  days: number
  extraHours: number
  pricePerDay: number
  explanation: string
}

export interface Ambiguity {
  type: string
  message: string
  options: string[]
}

export interface BookingDraft {
  sessionId: string
  officeId?: string
  officeName?: string
  categoryId?: string
  categoryName?: string
  pickupDateText?: string
  returnDateText?: string
  pickupDateISO?: string
  returnDateISO?: string
  driverAge?: number
  selectedGear?: 'manual' | 'automatic'
  customerPhone?: string
  customerName?: string
  pricePreview?: PricePreview
  ambiguity?: Ambiguity
  confirmed?: boolean
  readyForReservation?: boolean
  createdAt: string
  updatedAt: string
}

// ── Text Turn ────────────────────────────────────────────────────────────────
export interface TurnToolCall {
  tool: string
  success: boolean
  latencyMs: number
}

export interface TurnMetrics {
  totalMs: number
  stateLoadMs: number
  memoryReadMs: number
  contextLoadMs: number
  ruleCheckMs: number
  llmMs: number
  toolMs: number
  guardrailMs: number
  stateSaveMs: number
}

export interface TurnEvaluation {
  extractionAccuracy: number
  ruleCompliance: number
  taskProgress: number
  responseQuality: number
  humanHandoffRecommended: boolean
  notes: string[]
}

export interface TextTurnResponse {
  sessionId: string
  reply: string
  bookingDraft: BookingDraft
  workflowStep: string
  missingFields: string[]
  toolCalls: TurnToolCall[]
  metrics: TurnMetrics
  evaluation: TurnEvaluation
}

// ── Metrics ──────────────────────────────────────────────────────────────────
export interface MetricsResponse {
  metrics: {
    global: {
      total_turns: number
      successful_turns: number
      failed_turns: number
      avg_total_turn_latency_ms: number
      p95_total_turn_latency_ms: number
      sessions_created: number
      active_sessions: number
      completed_sessions: number
      error_rate: number
      fallback_rate: number
    }
    llm: {
      llm_calls_total: number
      llm_success_total: number
      llm_error_total: number
      avg_llm_latency_ms: number
      p95_llm_latency_ms: number
      avg_prompt_tokens: number
      avg_completion_tokens: number
      total_estimated_cost: number
      json_parse_failure_rate: number
      structured_output_validation_failure_rate: number
    }
    tools: {
      tool_calls_total: number
      tool_success_total: number
      tool_error_total: number
      avg_tool_latency_ms: number
      p95_tool_latency_ms: number
      most_used_tools: Record<string, number>
      tool_validation_failure_total: number
    }
    rules: {
      rules_checked_total: number
      rule_violations_total: number
      hard_rule_blocks_total: number
      soft_rule_warnings_total: number
      rule_violation_by_rule_id: Record<string, number>
      avg_rule_check_latency_ms: number
      customer_lead_time_blocks_total: number
      same_day_min_duration_blocks_total: number
      driver_age_blocks_total: number
      authentication_required_blocks_total: number
    }
    state: {
      sessions_loaded_total: number
      sessions_created_total: number
      sessions_updated_total: number
      missing_field_count_avg: number
      booking_completion_rate: number
    }
    workflow: {
      workflow_step_transition_total: number
      current_step_distribution: Record<string, number>
      workflow_completion_rate: number
      step_repetition_count: number
      repeated_question_count: number
    }
    memory: {
      memory_reads_total: number
      memory_writes_total: number
      transcript_message_count_avg: number
      memory_pruned_total: number
    }
    context: {
      context_load_total: number
      context_cache_hit_rate: number
      context_cache_miss_rate: number
      avg_context_load_latency_ms: number
    }
    guardrails: {
      guardrail_checks_total: number
      guardrail_blocks_total: number
      invented_price_block_total: number
      invented_office_block_total: number
      invented_category_block_total: number
      reservation_without_confirmation_block_total: number
      avg_guardrail_latency_ms: number
    }
    channels: {
      web_text_turns_total: number
      web_voice_turns_total: number
      websocket_connections_total: number
    }
    evaluation: {
      turns_evaluated_total: number
      extraction_accuracy_score_avg: number
      rule_compliance_score_avg: number
      task_progress_score_avg: number
      response_quality_score_avg: number
      human_handoff_recommended_total: number
    }
    pricing: {
      price_calculation_total: number
      price_calculation_success_total: number
      price_calculation_error_total: number
      avg_price_calculation_latency_ms: number
      pricing_tier_fallback_total: number
      automatic_gear_extra_applied_total: number
      addon_price_applied_total: number
    }
    availability: {
      time_slot_generation_total: number
      closed_date_detected_total: number
      exact_reserved_slot_block_total: number
      overlap_check_not_enforced_warning_total: number
    }
  }
  stateStats: { activeSessions: number; totalCreated: number; totalDeleted: number }
  memStats: { totalSessions: number; avgMessageCount: number; totalPruned: number }
  collectedAt: string
}

// ── Session ───────────────────────────────────────────────────────────────────
export interface TranscriptMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export interface SessionResponse {
  sessionId: string
  draft: BookingDraft
  transcript: TranscriptMessage[]
  turnCount: number
}

// ── Traces ────────────────────────────────────────────────────────────────────
export interface TraceLlmCall {
  model: string
  promptTokens: number
  completionTokens: number
  latencyMs: number
  purpose: string
  parseError?: string
}

export interface TraceToolCall {
  toolName: string
  success: boolean
  latencyMs: number
  error?: string
}

export interface TraceRule {
  ruleId: string
  passed: boolean
  severity: string
}

export interface TraceGuardrail {
  guardrailId: string
  passed: boolean
  blocked: boolean
}

export interface TurnTrace {
  turnId: string
  sessionId: string
  input: string
  intent?: string
  workflowStepBefore: string
  workflowStepAfter: string
  contextUsed: { officeCount: number; categoryCount: number; cacheHit: boolean }
  llmCalls: TraceLlmCall[]
  toolCalls: TraceToolCall[]
  rulesChecked: TraceRule[]
  guardrailsChecked: TraceGuardrail[]
  response: string
  metrics: TurnMetrics
  errors: string[]
}

export interface TracesResponse {
  traces: TurnTrace[]
}
