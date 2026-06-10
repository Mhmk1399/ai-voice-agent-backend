import { nanoid } from "nanoid";

import { stateManager, newSessionId } from "../state/in-memory-state.manager.js";
import { memoryStore } from "../memory/in-memory-memory.store.js";
import { contextProvider } from "../context/successvan-context.provider.js";
import {
  extractFromUserMessage,
  generateResponse,
} from "../llm/structured-extraction.service.js";
import { executeTool } from "../tools/tool-registry.js";
import {
  checkRulesSubset,
} from "../rules/rule-engine.js";
import {
  runWorkflow,
} from "../workflow/workflow-runner.js";
import { createInitialWorkflowState } from "../workflow/successvan.workflow.js";
import { runGuardrails } from "../guardrails/guardrail-engine.js";
import { LatencyTracker } from "../observability/latency-tracker.js";
import {
  recordTurn,
  recordLlmCall,
  recordToolCall,
  recordRuleCheck,
  recordGuardrailCheck,
  recordWorkflowStep,
  recordContextLoad,
  recordSessionCreated,
  recordChannelTurn,
  recordTrace,
} from "../observability/metrics-recorder.js";
import { evaluateTurn } from "../observability/evaluation.service.js";
import {
  normalizeText,
  extractAge,
  isAffirmative,
  isCancellation,
  wantsHumanHandoff as checkWantsHumanHandoff,
  extractGear,
  extractUkPhone,
} from "../utils/normalize-text.js";
import type { BookingDraft } from "../state/booking-draft.types.js";
import { getMissingFields } from "../state/booking-draft.types.js";
import type { BusinessContext } from "../context/context-provider.interface.js";
import type { WorkflowState } from "../workflow/workflow.types.js";
import type { TurnTrace } from "../observability/metrics.types.js";
import type { ToolCall } from "../tools/tool.types.js";
import type { AgentTurnInput, AgentTurnOutput } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// run-agent-turn — the main orchestration entrypoint
//
// Pipeline:
//   1.  Channel adapter validates input
//   2.  State manager loads session
//   3.  Memory loads transcript
//   4.  Context/RAG loads business context
//   5.  Deterministic extraction (age, gear, confirmation, cancellation, phone)
//   6.  Deterministic entity resolution (office, category) via tools
//   7.  LLM extraction only if needed (dates, unclear intent)
//   8.  Rule engine checks
//   9.  Workflow runner decides next step
//   10. Price tool called if needed
//   11. Guardrails verify and optionally rewrite response
//   12. State manager saves
//   13. Memory appends messages
//   14. Metrics + trace recorded
//   15. Evaluation scored
// ─────────────────────────────────────────────────────────────────────────────

// Per-session workflow state (separate from booking draft — not part of draft shape)
const workflowStateStore = new Map<string, WorkflowState>();

function getWorkflowState(sessionId: string): WorkflowState {
  return workflowStateStore.get(sessionId) ?? createInitialWorkflowState();
}

function saveWorkflowState(sessionId: string, state: WorkflowState): void {
  workflowStateStore.set(sessionId, state);
}

export async function runAgentTurn(
  input: AgentTurnInput
): Promise<AgentTurnOutput> {
  const turnId = nanoid(16);
  const latency = new LatencyTracker();
  const errors: string[] = [];
  const allToolCalls: ToolCall[] = [];
  const llmCalls: TurnTrace["llmCalls"] = [];
  let isNewSession = false;

  latency.mark("total_start");
  recordChannelTurn(input.channel);

  // ── 1. Resolve session ID ─────────────────────────────────────────────────

  const sessionId = input.sessionId ?? newSessionId();
  if (!input.sessionId) {
    isNewSession = true;
    recordSessionCreated();
  }

  // ── 2. State manager loads draft ──────────────────────────────────────────

  latency.mark("state_load_start");
  const draftBefore = await stateManager.load(sessionId);
  latency.mark("state_load_end");
  latency.measure("stateLoadMs", "state_load_start", "state_load_end");

  let draft = { ...draftBefore };
  const workflowStateBefore = getWorkflowState(sessionId);

  // ── 3. Memory loads transcript ────────────────────────────────────────────

  latency.mark("memory_read_start");
  const memory = await memoryStore.read(sessionId);
  latency.mark("memory_read_end");
  latency.measure("memoryReadMs", "memory_read_start", "memory_read_end");

  // ── 4. Context loads ──────────────────────────────────────────────────────

  latency.mark("context_load_start");
  let context = await contextProvider.load();
  const contextCacheHit = context.loadedAt !== new Date().toISOString(); // rough heuristic
  recordContextLoad(true); // context provider handles TTL internally
  latency.mark("context_load_end");
  latency.measure("contextLoadMs", "context_load_start", "context_load_end");

  // ── 5. Deterministic extraction ───────────────────────────────────────────

  const msg = input.message;
  const norm = normalizeText(msg);

  // Age
  if (!draft.driverAge) {
    const age = extractAge(msg);
    if (age != null) draft = { ...draft, driverAge: age };
  }

  // Gear
  if (!draft.selectedGear) {
    const gear = extractGear(msg);
    if (gear) draft = { ...draft, selectedGear: gear };
  }

  // Confirmation
  if (isAffirmative(msg) && !draft.confirmed) {
    const wf = workflowStateBefore.currentStep;
    if (wf === "confirmation") {
      draft = { ...draft, confirmed: true };
    }
  }

  // Cancellation
  if (isCancellation(msg)) {
    draft = { ...draft, confirmed: false, readyForReservation: false };
  }

  // Human handoff request
  const handoffRequested = checkWantsHumanHandoff(msg);

  // Phone
  if (!draft.customerPhone) {
    const phone = extractUkPhone(msg);
    if (phone) draft = { ...draft, customerPhone: phone };
  }

  // ── 6. Tool-based entity resolution (office, category) ────────────────────

  latency.mark("tool_start");

  // Only resolve if not already set
  if (!draft.officeId) {
    const officeCall = await executeTool("resolveOffice", { userText: msg });
    allToolCalls.push(officeCall);
    recordToolCall({ toolName: "resolveOffice", success: officeCall.output.success, latencyMs: officeCall.latencyMs });

    if (officeCall.output.success && officeCall.output.data) {
      const data = officeCall.output.data as any;
      if (data.match) {
        draft = { ...draft, officeId: data.match.id, officeName: data.match.name };
        // Clear any old ambiguity about office
        if (draft.ambiguity?.type === "office") draft = { ...draft, ambiguity: undefined };
      } else if (data.ambiguous) {
        draft = {
          ...draft,
          ambiguity: {
            type: "office",
            message: data.message ?? "Which office did you mean?",
            options: (data.candidates ?? []).map((c: any) => c.office.name),
          },
        };
      }
    }
  }

  if (!draft.categoryId) {
    const catCall = await executeTool("resolveCategory", {
      userText: msg,
      officeId: draft.officeId,
    });
    allToolCalls.push(catCall);
    recordToolCall({ toolName: "resolveCategory", success: catCall.output.success, latencyMs: catCall.latencyMs });

    if (catCall.output.success && catCall.output.data) {
      const data = catCall.output.data as any;
      if (data.match) {
        draft = { ...draft, categoryId: data.match.id, categoryName: data.match.name };
        if (draft.ambiguity?.type === "category") draft = { ...draft, ambiguity: undefined };
      } else if (data.ambiguous) {
        draft = {
          ...draft,
          ambiguity: {
            type: "category",
            message: data.message ?? "Which van type did you mean?",
            options: (data.candidates ?? []).map((c: any) => c.category.name),
          },
        };
      }
    }
  }

  // Resolve ambiguity: if we are in resolve_ambiguity step, check if user answered
  if (draft.ambiguity && workflowStateBefore.currentStep === "resolve_ambiguity") {
    const ambType = draft.ambiguity.type;
    if (ambType === "office" && draft.officeId) {
      draft = { ...draft, ambiguity: undefined };
      workflowStateBefore.resolvedAmbiguity = true;
    } else if (ambType === "category" && draft.categoryId) {
      draft = { ...draft, ambiguity: undefined };
      workflowStateBefore.resolvedAmbiguity = true;
    }
  }

  latency.mark("tool_end");
  latency.measure("toolMs", "tool_start", "tool_end");

  // ── 7. LLM extraction (dates and unclear intent) ──────────────────────────

  const needsLlm =
    !draft.pickupDateText ||
    !draft.returnDateText ||
    (!draft.driverAge && !extractAge(msg)); // Only skip LLM if deterministic got age

  latency.mark("llm_start");
  if (needsLlm && msg.trim().length > 0) {
    try {
      const extraction = await extractFromUserMessage({
        userMessage: msg,
        draft,
        context,
        recentTurns: memory.transcript,
      });

      llmCalls.push({
        model: extraction.llmResponse.model,
        promptTokens: extraction.llmResponse.promptTokens,
        completionTokens: extraction.llmResponse.completionTokens,
        latencyMs: extraction.llmResponse.latencyMs,
        purpose: "extraction",
        parseError: extraction.parseError,
      });

      recordLlmCall({
        success: !extraction.parseError,
        latencyMs: extraction.llmResponse.latencyMs,
        promptTokens: extraction.llmResponse.promptTokens,
        completionTokens: extraction.llmResponse.completionTokens,
        parseFailure: !!extraction.parseError,
      });

      const ext = extraction.result;

      // Merge extracted fields
      if (ext.pickupDateText && !draft.pickupDateText) {
        draft = { ...draft, pickupDateText: ext.pickupDateText };
      }
      if (ext.returnDateText && !draft.returnDateText) {
        draft = { ...draft, returnDateText: ext.returnDateText };
      }
      if (ext.driverAge && !draft.driverAge) {
        draft = { ...draft, driverAge: ext.driverAge };
      }
      if (ext.selectedGear && !draft.selectedGear) {
        draft = { ...draft, selectedGear: ext.selectedGear };
      }
      if (ext.customerName && !draft.customerName) {
        draft = { ...draft, customerName: ext.customerName };
      }
      if (ext.customerPhone && !draft.customerPhone) {
        draft = { ...draft, customerPhone: ext.customerPhone };
      }

      // Handle intent signals from LLM
      if (ext.wantsConfirmation && workflowStateBefore.currentStep === "confirmation") {
        draft = { ...draft, confirmed: true };
      }
      if (ext.wantsCancellation) {
        draft = { ...draft, confirmed: false };
      }

    } catch (err) {
      errors.push(`LLM extraction error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  latency.mark("llm_end");
  latency.measure("llmMs", "llm_start", "llm_end");

  // ── 8. Rule engine checks ─────────────────────────────────────────────────

  latency.mark("rule_start");
  const ruleIds = [
    "ASK_ONE_QUESTION_AT_A_TIME",
    "NO_INVENTED_PRICE",
    "REQUIRE_OFFICE",
    "REQUIRE_CATEGORY",
    "REQUIRE_PICKUP_AND_RETURN",
    "REQUIRE_DRIVER_AGE",
    "NO_RESERVATION_WITHOUT_CONFIRMATION",
  ];

  const ruleResults = checkRulesSubset(ruleIds, {
    draft,
    context,
    questionsAskedThisTurn: 1,
  });

  for (const r of ruleResults) {
    recordRuleCheck({ ruleId: r.ruleId, passed: r.passed, severity: r.severity });
  }
  latency.mark("rule_end");
  latency.measure("ruleCheckMs", "rule_start", "rule_end");

  // ── 9. Workflow runner ────────────────────────────────────────────────────

  // Override to human_handoff if requested
  const workflowStateForRun = handoffRequested
    ? { ...workflowStateBefore, currentStep: "human_handoff" as const }
    : workflowStateBefore;

  const workflowResult = runWorkflow(draft, workflowStateForRun, context);
  const updatedWorkflowState = workflowResult.workflowState;
  recordWorkflowStep(updatedWorkflowState.currentStep);

  // ── 10. Price calculation if workflow requests it ─────────────────────────

  if (workflowResult.shouldCallPriceTool && draft.categoryId && draft.pickupDateText && draft.returnDateText) {
    // Parse ISO dates from text — for now use a placeholder
    // Full date parsing would need a date parser; use the text as-is for preview display
    const priceCall = await executeTool("calculatePricePreview", {
      categoryId: draft.categoryId,
      pickupDateISO: draft.pickupDateISO ?? draft.pickupDateText,
      returnDateISO: draft.returnDateISO ?? draft.returnDateText,
      selectedGear: draft.selectedGear,
      addOns: draft.addOns,
    });
    allToolCalls.push(priceCall);
    recordToolCall({ toolName: "calculatePricePreview", success: priceCall.output.success, latencyMs: priceCall.latencyMs });

    if (priceCall.output.success && priceCall.output.data) {
      draft = { ...draft, pricePreview: priceCall.output.data as any };
    }
  }

  // ── 11. Build response ────────────────────────────────────────────────────

  let rawResponse = workflowResult.nextQuestion ?? "";

  // If workflow step is completed or human_handoff, use fixed messages
  if (updatedWorkflowState.currentStep === "human_handoff") {
    rawResponse = "I'll connect you with our team right away. One moment please.";
  } else if (updatedWorkflowState.currentStep === "completed") {
    rawResponse = "Your booking details are confirmed. Our team will follow up shortly.";
  }

  // If the workflow question is empty (edge case), generate via LLM
  if (!rawResponse && !errors.length) {
    try {
      const respCall = await generateResponse({
        systemPrompt: buildSystemPrompt(context),
        userMessage: msg,
        recentTurns: memory.transcript,
        responseHint: getResponseHint(updatedWorkflowState.currentStep, draft),
      });
      rawResponse = respCall.reply;

      llmCalls.push({
        model: respCall.llmResponse.model,
        promptTokens: respCall.llmResponse.promptTokens,
        completionTokens: respCall.llmResponse.completionTokens,
        latencyMs: respCall.llmResponse.latencyMs,
        purpose: "response",
      });
      recordLlmCall({
        success: true,
        latencyMs: respCall.llmResponse.latencyMs,
        promptTokens: respCall.llmResponse.promptTokens,
        completionTokens: respCall.llmResponse.completionTokens,
      });
    } catch (err) {
      rawResponse = "Sorry, I had a problem. Can you repeat that?";
      errors.push(`Response generation error: ${String(err)}`);
    }
  }

  // ── 12. Guardrails ────────────────────────────────────────────────────────

  latency.mark("guardrail_start");
  const guardrailResult = runGuardrails(rawResponse, { draft, context });
  for (const g of guardrailResult.results) {
    recordGuardrailCheck({ guardrailId: g.guardrailId, passed: g.passed, blocked: g.blocked });
  }
  const finalReply = guardrailResult.finalResponse;
  latency.mark("guardrail_end");
  latency.measure("guardrailMs", "guardrail_start", "guardrail_end");

  // ── 13. Save state and memory ─────────────────────────────────────────────

  latency.mark("state_save_start");
  await stateManager.save(sessionId, draft);
  latency.mark("state_save_end");
  latency.measure("stateSaveMs", "state_save_start", "state_save_end");

  saveWorkflowState(sessionId, updatedWorkflowState);

  await memoryStore.appendMessage(sessionId, {
    role: "user",
    content: msg,
    timestamp: new Date().toISOString(),
  });
  await memoryStore.appendMessage(sessionId, {
    role: "assistant",
    content: finalReply,
    timestamp: new Date().toISOString(),
  });

  // ── 14. Finalize metrics ──────────────────────────────────────────────────

  latency.mark("total_end");
  latency.measure("totalMs", "total_start", "total_end");

  const metricsRecord = {
    totalMs: latency.get("totalMs"),
    stateLoadMs: latency.get("stateLoadMs"),
    memoryReadMs: latency.get("memoryReadMs"),
    contextLoadMs: latency.get("contextLoadMs"),
    ruleCheckMs: latency.get("ruleCheckMs"),
    llmMs: latency.get("llmMs"),
    toolMs: latency.get("toolMs"),
    guardrailMs: latency.get("guardrailMs"),
    stateSaveMs: latency.get("stateSaveMs"),
  };

  recordTurn({ success: errors.length === 0, latencyMs: metricsRecord.totalMs });

  // ── 15. Build and store trace ─────────────────────────────────────────────

  const trace: TurnTrace = {
    turnId,
    sessionId,
    input: msg,
    stateBefore: draftBefore,
    stateAfter: draft,
    workflowStepBefore: workflowStateBefore.currentStep,
    workflowStepAfter: updatedWorkflowState.currentStep,
    contextUsed: {
      officeCount: context.offices.length,
      categoryCount: context.categories.length,
      addOnCount: context.addOns.length,
      cacheHit: true,
    },
    llmCalls,
    toolCalls: allToolCalls.map((tc) => ({
      toolName: tc.toolName,
      success: tc.output.success,
      latencyMs: tc.latencyMs,
      error: tc.error,
    })),
    rulesChecked: ruleResults.map((r) => ({
      ruleId: r.ruleId,
      passed: r.passed,
      severity: r.severity,
    })),
    guardrailsChecked: guardrailResult.results.map((g) => ({
      guardrailId: g.guardrailId,
      passed: g.passed,
      blocked: g.blocked,
    })),
    response: finalReply,
    metrics: metricsRecord,
    errors,
  };

  recordTrace(trace);

  const evaluation = evaluateTurn(trace);

  // ── Return ────────────────────────────────────────────────────────────────

  return {
    sessionId,
    reply: finalReply,
    bookingDraft: draft,
    workflowStep: updatedWorkflowState.currentStep,
    missingFields: getMissingFields(draft),
    toolCalls: allToolCalls,
    metrics: metricsRecord,
    evaluation,
    trace,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(context: BusinessContext): string {
  const officeList = context.offices.map((o) => `- ${o.name}`).join("\n");
  const catList = context.categories.map((c) => `- ${c.name}`).join("\n");

  return `You are a friendly, efficient van rental receptionist for SuccessVan.
Your job is to help customers book a van by collecting required information one question at a time.

Available offices:
${officeList}

Available vehicle types:
${catList}

Rules:
- Ask only ONE question per response.
- Keep responses short and phone-friendly.
- Never invent prices, availability, or office/category names.
- Only mention offices and categories from the lists above.
- Never create a booking without explicit customer confirmation.`;
}

function getResponseHint(step: string, draft: BookingDraft): string {
  const hints: Record<string, string> = {
    greeting: "a short friendly greeting asking which type of van they need",
    collect_office: "ask which office they want to collect from",
    collect_category: "ask which type of van they need",
    collect_pickup_datetime: "ask what date and time the rental should start",
    collect_return_datetime: "ask when they will return the van",
    collect_driver_age: "ask how old the driver is",
    resolve_ambiguity: draft.ambiguity?.message ?? "ask for clarification",
    price_preview: `tell them the price is £${draft.pricePreview?.totalPrice?.toFixed(2) ?? "calculating"} and ask if they want to confirm`,
    confirmation: "ask if they want to confirm the booking",
    ready_for_reservation: "ask for their name and phone number",
    human_handoff: "tell them you are connecting them to the team",
    completed: "confirm their booking is complete",
  };
  return hints[step] ?? "a helpful response";
}
