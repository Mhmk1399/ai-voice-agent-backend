import { nanoid } from "nanoid";

import { stateManager, newSessionId } from "../state/in-memory-state.manager.js";
import { memoryStore } from "../memory/in-memory-memory.store.js";
import { contextProvider } from "../context/successvan-context.provider.js";
import {
  extractFromUserMessage,
  generateBusinessAnswer,
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
import { checkOfficeTimePolicy } from "../time/successvan-time-slot.service.js";
import {
  checkRequestedReservationSlots,
  checkSingleReservationSlot,
  getAvailableTimeSlots,
} from "../time/successvan-availability.service.js";
import {
  formatLondonDate,
  formatLondonTime,
  getLondonDateParts,
  withLondonWallTime,
} from "../utils/london-time.js";
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
  extractEmail,
  extractCustomerName,
} from "../utils/normalize-text.js";
import type { BookingDraft } from "../state/booking-draft.types.js";
import { getMissingFields } from "../state/booking-draft.types.js";
import type { BusinessContext } from "../context/context-provider.interface.js";
import type { WorkflowState, WorkflowStep } from "../workflow/workflow.types.js";
import { classifyIntent } from "./intent-classifier.js";
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

  // ── 4.5. Intent classification ───────────────────────────────────────────
  // Fast, small LLM call that routes non-booking messages before the pipeline.
  // FALLBACK: on any failure, returns "unknown" so the pipeline always runs.

  const recentConversation = memory.transcript
    .slice(-4)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const intentResult = await classifyIntent(
    input.message,
    recentConversation || undefined
  );

  llmCalls.push({
    model: intentResult.llmResponse.model,
    promptTokens: intentResult.llmResponse.promptTokens,
    completionTokens: intentResult.llmResponse.completionTokens,
    latencyMs: intentResult.llmResponse.latencyMs,
    purpose: "intent_classification",
    parseError: intentResult.parseError,
  });

  recordLlmCall({
    success: !intentResult.parseError,
    latencyMs: intentResult.llmResponse.latencyMs,
    promptTokens: intentResult.llmResponse.promptTokens,
    completionTokens: intentResult.llmResponse.completionTokens,
    parseFailure: !!intentResult.parseError,
  });

  if (intentResult.parseError) {
    errors.push(`Intent classifier: ${intentResult.parseError}`);
  }

  // Routing flags — applied after the full pipeline, before guardrails.
  // This means extraction/tools still run (no wasted state), but the final
  // response and workflow step are overridden for non-booking intents.
  let skipPipeline = false;
  let pipelineOverrideReply: string | null = null;
  let pipelineOverrideStep: WorkflowStep | null = null;

  const effectiveIntent =
    intentResult.intent === "support_request" &&
    isActiveBookingPolicyQuestion(input.message, draft)
      ? "question"
      : intentResult.intent;

  if (effectiveIntent === "support_request") {
    skipPipeline = true;
    pipelineOverrideReply =
      "I understand you need help with an existing booking or have a support " +
      "question. Let me connect you with our team right away. Please hold.";
    pipelineOverrideStep = "human_handoff";
  } else if (effectiveIntent === "out_of_scope") {
    skipPipeline = true;
    pipelineOverrideReply =
      "I can only help with van rental bookings. Would you like help renting a van?";
    // Workflow step stays unchanged — don't advance the booking flow
  }

  // ── 5. Deterministic extraction ───────────────────────────────────────────

  const msg = input.message;
  const questionLike = isQuestionLike(msg, effectiveIntent);
  const addOnInfoRequested = wantsAddOnsInfo(msg);
  const timeFeeInfoRequested = wantsTimeFeeInfo(msg);
  const pickupSlotInfoRequested = wantsPickupSlotInfo(msg);
  const returnSlotInfoRequested = wantsReturnSlotInfo(msg);
  const comparesCategoryAvailability = wantsCategoryAvailabilityComparison(msg);
  const pickupTimeChangeRequested = wantsPickupTimeChange(msg);
  const returnTimeChangeRequested = wantsReturnTimeChange(msg);
  const slotInfoRequested = pickupSlotInfoRequested || returnSlotInfoRequested;
  const categoryCorrectionRequested = wantsCategoryCorrection(msg);
  let requestedPickupSlotDateISO: string | undefined;
  let requestedReturnSlotDateISO: string | undefined;

  // Age
  if (!draft.driverAge) {
    const age = extractAge(msg);
    if (age != null) draft = { ...draft, driverAge: age };
  }

  // Gear
  if (!draft.selectedGear) {
    const gear = extractGear(msg);
    if (gear) {
      draft = { ...draft, selectedGear: gear, gearConfirmed: true, pricePreview: undefined };
    } else if (workflowStateBefore.currentStep === "collect_gear" && acceptsDefaultGear(msg)) {
      const defaultGear = getDefaultGearForCategory(draft, context);
      if (defaultGear) {
        draft = {
          ...draft,
          selectedGear: defaultGear,
          gearConfirmed: true,
          pricePreview: undefined,
        };
      }
    }
  }

  // Confirmation
  if (isAffirmative(msg) && !draft.confirmed) {
    const wf = workflowStateBefore.currentStep;
    if (wf === "confirmation") {
      draft = { ...draft, confirmed: true };
    }
  }

  if (workflowStateBefore.currentStep === "verify_customer" && isAffirmative(msg)) {
    draft = { ...draft, customerVerified: true };
  }

  if (workflowStateBefore.currentStep === "accept_terms" && acceptsTerms(msg)) {
    draft = { ...draft, termsAccepted: true };
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

  // Customer name / email
  if (!draft.customerName) {
    const name = extractCustomerName(msg);
    if (name) draft = { ...draft, customerName: name };
  }
  if (!draft.customerEmail) {
    const email = extractEmail(msg);
    if (email) draft = { ...draft, customerEmail: email };
  }

  if (workflowStateBefore.currentStep === "collect_add_ons" || addOnInfoRequested) {
    draft = { ...draft, addOnsOffered: true };
    if (declinesAddOns(msg)) {
      draft = { ...draft, addOns: [], addOnsConfirmed: true, pricePreview: undefined };
    } else {
      const selectedAddOns = extractAddOns(msg, context);
      if (selectedAddOns.length > 0) {
        draft = {
          ...draft,
          addOns: selectedAddOns,
          addOnsConfirmed: true,
          pricePreview: undefined,
        };
      }
    }
  }

  // ── 6. LLM extraction ────────────────────────────────────────────────────
  // Runs BEFORE tool resolution so tools receive a clean, context-resolved
  // entity name ("London Stratford") instead of raw conversational text
  // ("the first one", "same as before", "doesn't matter").
  // Always runs — no gate — so every turn benefits from contextual understanding.

  latency.mark("llm_start");
  let extractedOfficeName: string | undefined;
  let extractedCategoryName: string | undefined;

  if (msg.trim().length > 0) {
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

      // Capture entity names for tool resolution below
      if (ext.officeName) extractedOfficeName = ext.officeName;
      if (ext.categoryName) extractedCategoryName = ext.categoryName;

      // Merge scalar fields
      if (ext.pickupDateText && (!draft.pickupDateText || pickupTimeChangeRequested)) {
        draft = { ...draft, pickupDateText: ext.pickupDateText };
      }
      if (ext.returnDateText && (!draft.returnDateText || returnTimeChangeRequested)) {
        draft = { ...draft, returnDateText: ext.returnDateText };
      }
      if (ext.pickupDateISO && (!draft.pickupDateISO || pickupTimeChangeRequested)) {
        if (pickupSlotInfoRequested) requestedPickupSlotDateISO = ext.pickupDateISO;
        draft = resetQuoteAfterTimeChange({ ...draft, pickupDateISO: ext.pickupDateISO });
      }
      if (ext.returnDateISO && (!draft.returnDateISO || returnTimeChangeRequested)) {
        if (returnSlotInfoRequested) requestedReturnSlotDateISO = ext.returnDateISO;
        draft = resetQuoteAfterTimeChange({ ...draft, returnDateISO: ext.returnDateISO });
      }
      if (ext.driverAge && !draft.driverAge) {
        draft = { ...draft, driverAge: ext.driverAge };
      }
      if (ext.selectedGear && !draft.selectedGear) {
        draft = { ...draft, selectedGear: ext.selectedGear, gearConfirmed: true, pricePreview: undefined };
      }
      if (ext.customerName && !draft.customerName) {
        draft = { ...draft, customerName: ext.customerName };
      }
      if (ext.customerPhone && !draft.customerPhone) {
        draft = {
          ...draft,
          customerPhone: extractUkPhone(ext.customerPhone) ?? ext.customerPhone,
        };
      }
      if (ext.customerEmail && !draft.customerEmail) {
        draft = { ...draft, customerEmail: ext.customerEmail };
      }
      if (pickupSlotInfoRequested && !requestedPickupSlotDateISO) {
        requestedPickupSlotDateISO = dateOnlyIsoForSlotLookup(
          ext.pickupDateText ?? msg
        );
      }
      if (returnSlotInfoRequested && !requestedReturnSlotDateISO) {
        requestedReturnSlotDateISO = dateOnlyIsoForSlotLookup(
          ext.returnDateText ?? msg
        );
      }

      // Intent signals
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

  if (pickupTimeChangeRequested && draft.pickupDateISO) {
    const newTime = extractClockTime(msg);
    if (newTime) {
      draft = resetQuoteAfterTimeChange({
        ...draft,
        pickupDateISO: withLondonWallTime(draft.pickupDateISO, newTime),
        pickupDateText: `${formatLondonDate(new Date(draft.pickupDateISO))} at ${newTime}`,
      });
    }
  }
  if (returnTimeChangeRequested && draft.returnDateISO) {
    const newTime = extractClockTime(msg);
    if (newTime) {
      draft = resetQuoteAfterTimeChange({
        ...draft,
        returnDateISO: withLondonWallTime(draft.returnDateISO, newTime),
        returnDateText: `${formatLondonDate(new Date(draft.returnDateISO))} at ${newTime}`,
      });
    }
  }

  if (pickupSlotInfoRequested && !hasExplicitClockTime(msg)) {
    draft = {
      ...draft,
      pickupDateISO: undefined,
      pricePreview: undefined,
      confirmed: false,
      readyForReservation: false,
    };
  }
  if (returnSlotInfoRequested && !hasExplicitClockTime(msg)) {
    draft = {
      ...draft,
      returnDateISO: undefined,
      pricePreview: undefined,
      confirmed: false,
      readyForReservation: false,
    };
  }

  // ── 7. Tool-based entity resolution ──────────────────────────────────────
  // Uses the LLM-extracted clean name when available.
  // Falls back to raw message only when LLM found no name this turn.
  // This means "same office", "the first one", "that van" all resolve correctly
  // because the LLM resolved the reference first.

  latency.mark("tool_start");

  if (!draft.officeId) {
    // Prefer LLM-extracted name; fall back to raw message
    const officeText = extractedOfficeName ?? msg;
    const officeCall = await executeTool("resolveOffice", { userText: officeText });
    allToolCalls.push(officeCall);
    recordToolCall({ toolName: "resolveOffice", success: officeCall.output.success, latencyMs: officeCall.latencyMs });

    if (officeCall.output.success && officeCall.output.data) {
      const data = officeCall.output.data as any;
      if (data.match) {
        draft = { ...draft, officeId: data.match.id, officeName: data.match.name };
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

  if (!draft.categoryId || categoryCorrectionRequested || extractedCategoryName) {
    // Prefer LLM-extracted name; fall back to raw message
    const categoryText = extractedCategoryName ?? msg;
    const catCall = await executeTool("resolveCategory", {
      userText: categoryText,
      officeId: draft.officeId,
    });
    allToolCalls.push(catCall);
    recordToolCall({ toolName: "resolveCategory", success: catCall.output.success, latencyMs: catCall.latencyMs });

    if (catCall.output.success && catCall.output.data) {
      const data = catCall.output.data as any;
      if (data.match) {
        const categoryChanged = draft.categoryId && draft.categoryId !== data.match.id;
        draft = {
          ...draft,
          categoryId: data.match.id,
          categoryName: data.match.name,
          ...(categoryChanged
            ? {
                selectedGear: undefined,
                gearConfirmed: false,
                addOns: undefined,
                addOnsConfirmed: false,
                addOnsOffered: false,
                pricePreview: undefined,
                confirmed: false,
                readyForReservation: false,
              }
            : {}),
        };
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

  // ── 7.5. Deterministic office time availability ──────────────────────────
  // The LLM may understand "is it possible?", but it must not decide
  // availability. Office hours, extension windows, and special days are a
  // hard business-policy layer.
  const timePolicyValidation = await validateDraftOfficeTimes(draft, context);
  if (timePolicyValidation.failure) {
    draft = timePolicyValidation.draft;
  }

  // ── 8. Rule engine checks ─────────────────────────────────────────────────

  latency.mark("rule_start");
  const ruleIds = [
    "ASK_ONE_QUESTION_AT_A_TIME",
    "NO_INVENTED_PRICE",
    "REQUIRE_OFFICE",
    "REQUIRE_CATEGORY",
    "REQUIRE_PICKUP_AND_RETURN",
    "REQUIRE_DRIVER_AGE",
    "REQUIRE_GEAR_DECISION",
    "REQUIRE_ADD_ON_DECISION_BEFORE_PRICE",
    "REQUIRE_VERIFICATION_AND_TERMS",
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
  let updatedWorkflowState = workflowResult.workflowState;
  recordWorkflowStep(updatedWorkflowState.currentStep);

  // ── 10. Price calculation if workflow requests it ─────────────────────────

  let priceCalculationFailed = false;
  let availabilityFailedReason: string | null = null;

  if (workflowResult.shouldCallPriceTool && draft.categoryId && draft.pickupDateText && draft.returnDateText) {
    if (!draft.pickupDateISO || !draft.returnDateISO) {
      priceCalculationFailed = true;
    } else {
      const availability = await checkRequestedReservationSlots({
        officeId: draft.officeId,
        pickupDateISO: draft.pickupDateISO,
        returnDateISO: draft.returnDateISO,
      });
      if (!availability.available) {
        availabilityFailedReason = availability.reason ?? "That time is already reserved.";
        priceCalculationFailed = true;
      } else {
        const priceCall = await executeTool("calculatePricePreview", {
          categoryId: draft.categoryId,
          officeId: draft.officeId,
          pickupDateISO: draft.pickupDateISO,
          returnDateISO: draft.returnDateISO,
          selectedGear: draft.selectedGear,
          addOns: draft.addOns,
        });
        allToolCalls.push(priceCall);
        recordToolCall({ toolName: "calculatePricePreview", success: priceCall.output.success, latencyMs: priceCall.latencyMs });

        if (priceCall.output.success && priceCall.output.data) {
          draft = { ...draft, pricePreview: priceCall.output.data as any };
        } else {
          priceCalculationFailed = true;
        }
      }
    }
  }

  // ── 11. Build response ────────────────────────────────────────────────────

  if (
    draft.confirmed &&
    draft.customerName &&
    draft.customerPhone &&
    draft.customerVerified &&
    draft.termsAccepted &&
    draft.pricePreview &&
    draft.addOnsConfirmed &&
    !addOnInfoRequested
  ) {
    draft = { ...draft, readyForReservation: true };
  }

  let rawResponse = workflowResult.nextQuestion ?? "";

  if (workflowResult.shouldCallPriceTool) {
    if (draft.pricePreview) {
      rawResponse = buildPricePreviewResponse(draft);
    } else if (availabilityFailedReason) {
      rawResponse = availabilityFailedReason;
      updatedWorkflowState = {
        ...updatedWorkflowState,
        currentStep: "collect_pickup_datetime",
      };
    } else if (priceCalculationFailed) {
      rawResponse =
        "I could not calculate the price from those dates. What pickup and return date and time would you like?";
      updatedWorkflowState = {
        ...updatedWorkflowState,
        currentStep: "collect_pickup_datetime",
      };
    }
  }

  if (timePolicyValidation.failure) {
    rawResponse =
      timePolicyValidation.failure.step === "human_handoff"
        ? timePolicyValidation.failure.message
        : `${timePolicyValidation.failure.message} ${rawResponse}`;
    updatedWorkflowState = {
      ...updatedWorkflowState,
      currentStep: timePolicyValidation.failure.step,
    };
  }

  if (!timePolicyValidation.failure && slotInfoRequested) {
    rawResponse = await buildAvailableTimeSlotsResponse({
      draft,
      context,
      kind: pickupSlotInfoRequested ? "pickup" : "return",
      requestedDateISO: pickupSlotInfoRequested
        ? requestedPickupSlotDateISO
        : requestedReturnSlotDateISO,
      continuationQuestion: rawResponse || undefined,
    });
    updatedWorkflowState = {
      ...updatedWorkflowState,
      currentStep: pickupSlotInfoRequested
        ? "collect_pickup_datetime"
        : "collect_return_datetime",
    };
  }

  if (!timePolicyValidation.failure && !slotInfoRequested && comparesCategoryAvailability) {
    rawResponse =
      "Pickup and return time windows are set by the office, but vehicle availability can differ by van category because reservations are category-specific. I can check the available pickup times for the selected van and date.";
  }

  // If workflow step is completed or human_handoff, use fixed messages
  if (updatedWorkflowState.currentStep === "human_handoff") {
    rawResponse = "I'll connect you with our team right away. One moment please.";
  } else if (updatedWorkflowState.currentStep === "completed") {
    rawResponse = "Your booking request is ready as a pending SuccessVan website reservation. Our team will follow up shortly.";
  } else if (updatedWorkflowState.currentStep === "ready_for_pending_reservation") {
    rawResponse = "All required details are collected, including add-ons, customer verification, and terms. I can now prepare the pending website reservation.";
    draft = { ...draft, readyForReservation: true };
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

  // Let the AI answer real customer questions, then continue the deterministic
  // workflow with the next safe question. Guardrails still run afterwards.
  if (
    questionLike &&
    !skipPipeline &&
    !timePolicyValidation.failure &&
    !slotInfoRequested &&
    !comparesCategoryAvailability &&
    updatedWorkflowState.currentStep !== "human_handoff" &&
    updatedWorkflowState.currentStep !== "completed"
  ) {
    try {
      if (addOnInfoRequested) {
        rawResponse = buildAddOnsResponse(context, rawResponse || undefined);
      } else if (timeFeeInfoRequested && !pickupTimeChangeRequested && !returnTimeChangeRequested) {
        rawResponse = buildTimeFeeResponse(draft, context, rawResponse || undefined);
      } else {
        const answerCall = await generateBusinessAnswer({
          userMessage: msg,
          recentTurns: memory.transcript,
          draft,
          context,
          continuationQuestion: rawResponse || undefined,
        });
        rawResponse = answerCall.reply;

        llmCalls.push({
          model: answerCall.llmResponse.model,
          promptTokens: answerCall.llmResponse.promptTokens,
          completionTokens: answerCall.llmResponse.completionTokens,
          latencyMs: answerCall.llmResponse.latencyMs,
          purpose: "response",
        });
        recordLlmCall({
          success: true,
          latencyMs: answerCall.llmResponse.latencyMs,
          promptTokens: answerCall.llmResponse.promptTokens,
          completionTokens: answerCall.llmResponse.completionTokens,
        });
      }
    } catch (err) {
      errors.push(`Business answer error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Intent routing override ───────────────────────────────────────────────
  // Applied after the pipeline so extraction/state still runs normally.
  // For support_request / out_of_scope: override response and workflow step.
  if (skipPipeline && pipelineOverrideReply) {
    rawResponse = pipelineOverrideReply;
    if (pipelineOverrideStep) {
      updatedWorkflowState = {
        ...updatedWorkflowState,
        currentStep: pipelineOverrideStep,
      };
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
    intent: effectiveIntent,
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
    collect_gear: "ask whether they want manual or automatic gearbox",
    resolve_ambiguity: draft.ambiguity?.message ?? "ask for clarification",
    collect_add_ons: "list available add-ons and ask whether they want any, or no add-ons",
    price_preview: draft.pricePreview
      ? `tell them the price is £${draft.pricePreview.totalPrice.toFixed(2)} and ask if they want to confirm`
      : "explain that valid pickup and return dates are needed before calculating the price",
    confirmation: "ask if they want to confirm the booking",
    verify_customer: "collect name and phone, then confirm phone verification",
    accept_terms: "ask the customer to accept the terms and conditions",
    ready_for_pending_reservation: "say all details are ready for a pending website reservation",
    human_handoff: "tell them you are connecting them to the team",
    completed: "confirm their booking is complete",
  };
  return hints[step] ?? "a helpful response";
}

function acceptsDefaultGear(text: string): boolean {
  const norm = normalizeText(text);
  return (
    isAffirmative(text) ||
    norm.includes("continue") ||
    norm.includes("default") ||
    norm.includes("doesnt matter") ||
    norm.includes("don t mind") ||
    norm.includes("any gearbox") ||
    norm.includes("either")
  );
}

function getDefaultGearForCategory(
  draft: BookingDraft,
  context: BusinessContext
): "manual" | "automatic" | null {
  const category = context.categories.find((c) => c.id === draft.categoryId);
  const types = category?.gear?.availableTypes ?? [];
  if (types.includes("manual")) return "manual";
  if (types.includes("automatic")) return "automatic";
  return null;
}

async function validateDraftOfficeTimes(
  draft: BookingDraft,
  context: BusinessContext
): Promise<{
  draft: BookingDraft;
  failure?: { message: string; step: WorkflowStep };
}> {
  const office = context.offices.find((o) => o.id === draft.officeId);
  if (!office) return { draft };

  if (draft.pickupDateISO) {
    const pickupDate = new Date(draft.pickupDateISO);
    if (!isNaN(pickupDate.getTime())) {
      if (isSameLondonCalendarDay(pickupDate, new Date())) {
        return {
          draft: {
            ...draft,
            pickupDateText: undefined,
            pickupDateISO: undefined,
            returnDateText: undefined,
            returnDateISO: undefined,
            pricePreview: undefined,
            confirmed: false,
            readyForReservation: false,
          },
          failure: {
            step: "human_handoff",
            message:
              "Same-day reservations cannot be booked automatically online. I'll connect you with our team to check whether they can help today.",
          },
        };
      }

      const pickupTime = formatLondonTime(pickupDate);
      const pickupPolicy = checkOfficeTimePolicy(
        pickupDate,
        pickupTime,
        office,
        "pickup"
      );

      if (!pickupPolicy.available) {
        return {
          draft: {
            ...draft,
            pickupDateText: undefined,
            pickupDateISO: undefined,
            returnDateText: undefined,
            returnDateISO: undefined,
            pricePreview: undefined,
            confirmed: false,
            readyForReservation: false,
          },
          failure: {
            step: "collect_pickup_datetime",
            message: `Pickup at ${pickupTime} is not available at ${office.name}. ${pickupPolicy.reason}`,
          },
        };
      }

      const reserved = await checkSingleReservationSlot({
        officeId: draft.officeId,
        office,
        dateISO: draft.pickupDateISO,
        kind: "pickup",
      });
      if (!reserved.available) {
        return {
          draft: {
            ...draft,
            pickupDateText: undefined,
            pickupDateISO: undefined,
            returnDateText: undefined,
            returnDateISO: undefined,
            pricePreview: undefined,
            confirmed: false,
            readyForReservation: false,
          },
          failure: {
            step: "collect_pickup_datetime",
            message: reserved.reason ?? "That pickup time is already reserved.",
          },
        };
      }
    }
  }

  if (draft.returnDateISO) {
    const returnDate = new Date(draft.returnDateISO);
    if (!isNaN(returnDate.getTime())) {
      const returnTime = formatLondonTime(returnDate);
      const returnPolicy = checkOfficeTimePolicy(
        returnDate,
        returnTime,
        office,
        "return"
      );

      if (!returnPolicy.available) {
        return {
          draft: {
            ...draft,
            returnDateText: undefined,
            returnDateISO: undefined,
            pricePreview: undefined,
            confirmed: false,
            readyForReservation: false,
          },
          failure: {
            step: "collect_return_datetime",
            message: `Return at ${returnTime} is not available at ${office.name}. ${returnPolicy.reason}`,
          },
        };
      }

      const reserved = await checkSingleReservationSlot({
        officeId: draft.officeId,
        office,
        dateISO: draft.returnDateISO,
        kind: "return",
      });
      if (!reserved.available) {
        return {
          draft: {
            ...draft,
            returnDateText: undefined,
            returnDateISO: undefined,
            pricePreview: undefined,
            confirmed: false,
            readyForReservation: false,
          },
          failure: {
            step: "collect_return_datetime",
            message: reserved.reason ?? "That return time is already reserved.",
          },
        };
      }
    }
  }

  return { draft };
}

function isSameLondonCalendarDay(left: Date, right: Date): boolean {
  return formatLondonDate(left) === formatLondonDate(right);
}

function buildPricePreviewResponse(draft: BookingDraft): string {
  if (!draft.pricePreview) {
    return "I need valid pickup and return dates before I can calculate the price.";
  }

  const parts = [`The estimated total is £${draft.pricePreview.totalPrice.toFixed(2)}`];
  if (draft.pricePreview.explanation) {
    parts.push(`(${draft.pricePreview.explanation})`);
  }
  parts.push("Shall I confirm this booking?");
  return parts.join(" ");
}

function isQuestionLike(text: string, intent?: string): boolean {
  if (intent === "question") return true;
  if (text.includes("?")) return true;

  const norm = normalizeText(text);
  const questionStarts = [
    "what",
    "which",
    "how",
    "why",
    "when",
    "where",
    "can",
    "could",
    "do",
    "does",
    "is",
    "are",
    "should",
  ];
  if (questionStarts.some((w) => norm.startsWith(`${w} `))) return true;

  return [
    "suitable",
    "recommend",
    "suggest",
    "how much",
    "price",
    "cost",
    "available",
    "availability",
    "open",
    "opening",
  ].some((phrase) => norm.includes(phrase));
}

function isActiveBookingPolicyQuestion(text: string, draft: BookingDraft): boolean {
  if (!draft.officeId && !draft.categoryId && !draft.pricePreview) return false;
  const norm = normalizeText(text);
  return (
    norm.includes("why") ||
    norm.includes("extension") ||
    norm.includes("extra") ||
    norm.includes("fee") ||
    norm.includes("charge") ||
    norm.includes("pay") ||
    norm.includes("price") ||
    norm.includes("cost") ||
    norm.includes("add on") ||
    norm.includes("addon") ||
    norm.includes("working hour") ||
    norm.includes("opening hour") ||
    norm.includes("holiday") ||
    norm.includes("special day")
  );
}

function wantsAddOnsInfo(text: string): boolean {
  const norm = normalizeText(text);
  return (
    norm.includes("add on") ||
    norm.includes("addon") ||
    norm.includes("extras") ||
    norm.includes("insurance") ||
    norm.includes("cover")
  );
}

function wantsTimeFeeInfo(text: string): boolean {
  const norm = normalizeText(text);
  return (
    norm.includes("extension") ||
    norm.includes("extra hours") ||
    norm.includes("extra hour") ||
    norm.includes("calculation") ||
    norm.includes("calculate") ||
    norm.includes("breakdown") ||
    norm.includes("extra hour") ||
    norm.includes("outside") ||
    norm.includes("working hour") ||
    norm.includes("opening hour") ||
    norm.includes("why should i pay") ||
    norm.includes("pay more") ||
    norm.includes("fee") ||
    norm.includes("charge") ||
    norm.includes("special day") ||
    norm.includes("holiday")
  );
}

function wantsPickupSlotInfo(text: string): boolean {
  const norm = normalizeText(text);
  const asksAvailability =
    norm.includes("available") ||
    norm.includes("availability") ||
    norm.includes("availble");
  const asksTime =
    norm.includes("time") || norm.includes("times") || norm.includes("slot");
  return (
    asksAvailability &&
    asksTime &&
    !norm.includes("return") &&
    !norm.includes("drop off") &&
    !norm.includes("dropoff")
  );
}

function wantsReturnSlotInfo(text: string): boolean {
  const norm = normalizeText(text);
  const asksAvailability =
    norm.includes("available") ||
    norm.includes("availability") ||
    norm.includes("availble");
  return (
    asksAvailability &&
    (norm.includes("return") || norm.includes("drop off") || norm.includes("dropoff")) &&
    (norm.includes("time") || norm.includes("times") || norm.includes("slot"))
  );
}

function wantsCategoryCorrection(text: string): boolean {
  const norm = normalizeText(text);
  return (
    norm.includes("sorry i want") ||
    norm.includes("i want a") ||
    norm.includes("change to") ||
    norm.includes("switch to") ||
    norm.includes("instead") ||
    norm.includes("not the") ||
    norm.includes("short") ||
    norm.includes("long wheel") ||
    norm.includes("seater")
  );
}

function wantsCategoryAvailabilityComparison(text: string): boolean {
  const norm = normalizeText(text);
  return (
    norm.includes("availability") &&
    (norm.includes("same") || norm.includes("different")) &&
    (norm.includes("seater") ||
      norm.includes("short") ||
      norm.includes("long") ||
      norm.includes("van"))
  );
}

function wantsPickupTimeChange(text: string): boolean {
  const norm = normalizeText(text);
  return (
    (norm.includes("change") ||
      norm.includes("move") ||
      norm.includes("switch") ||
      norm.includes("instead")) &&
    (norm.includes("pickup") || norm.includes("pick up") || norm.includes("collect"))
  );
}

function wantsReturnTimeChange(text: string): boolean {
  const norm = normalizeText(text);
  return (
    (norm.includes("change") ||
      norm.includes("move") ||
      norm.includes("switch") ||
      norm.includes("instead")) &&
    norm.includes("return")
  );
}

function resetQuoteAfterTimeChange(draft: BookingDraft): BookingDraft {
  return {
    ...draft,
    pricePreview: undefined,
    confirmed: false,
    readyForReservation: false,
  };
}

function extractClockTime(text: string): string | null {
  const ampm = text.match(/\b(1[0-2]|0?[1-9])\s*(am|pm)\b/i);
  if (ampm) {
    let hour = Number(ampm[1]);
    const meridiem = ampm[2].toLowerCase();
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:00`;
  }

  const hm = text.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (hm) {
    return `${String(Number(hm[1])).padStart(2, "0")}:${hm[2]}`;
  }

  const hour24 = normalizeText(text).match(/\b(?:at|to)\s+([01]?\d|2[0-3])\b/);
  if (hour24) {
    return `${String(Number(hour24[1])).padStart(2, "0")}:00`;
  }

  return null;
}

function dateOnlyIsoForSlotLookup(text: string): string | undefined {
  const norm = normalizeText(text);
  const base = new Date();
  const parts = getLondonDateParts(base);
  let year = parts.year;
  let month = parts.month;
  let day = parts.day;

  if (norm.includes("tomorrow") || norm.includes("tommorow") || norm.includes("tommoriw")) {
    const d = new Date(Date.UTC(year, month - 1, day + 1, 12, 0, 0));
    const p = getLondonDateParts(d);
    year = p.year;
    month = p.month;
    day = p.day;
  } else {
    const inDays = norm.match(/\b(?:in\s+)?(\d+)\s+days?(?:\s+from\s+now)?\b/);
    const ordinal = norm.match(/\b([0-3]?\d)(?:st|nd|rd|th)?\b/);
    if (inDays) {
      const d = new Date(Date.UTC(year, month - 1, day + Number(inDays[1]), 12, 0, 0));
      const p = getLondonDateParts(d);
      year = p.year;
      month = p.month;
      day = p.day;
    } else if (ordinal) {
      const candidateDay = Number(ordinal[1]);
      if (candidateDay >= 1 && candidateDay <= 31) {
        day = candidateDay;
        const todayOrdinal =
          parts.year * 10_000 + parts.month * 100 + parts.day;
        let candidateOrdinal = year * 10_000 + month * 100 + day;
        if (candidateOrdinal < todayOrdinal) {
          month += 1;
          if (month > 12) {
            month = 1;
            year += 1;
          }
        }
      } else {
        return undefined;
      }
    } else {
      return undefined;
    }
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00+01:00`;
}

function hasExplicitClockTime(text: string): boolean {
  const norm = normalizeText(text);
  return (
    /\b([01]?\d|2[0-3])[:.][0-5]\d\b/.test(text) ||
    /\b(1[0-2]|0?[1-9])\s*(am|pm)\b/i.test(text) ||
    /\b(noon|midnight)\b/.test(norm)
  );
}

function declinesAddOns(text: string): boolean {
  const norm = normalizeText(text);
  return (
    norm.includes("no add") ||
    norm.includes("without add") ||
    norm.includes("no extra") ||
    norm.includes("none") ||
    norm.includes("skip add") ||
    norm.includes("continue without")
  );
}

function acceptsTerms(text: string): boolean {
  const norm = normalizeText(text);
  return (
    isAffirmative(text) ||
    norm.includes("accept terms") ||
    norm.includes("agree to terms") ||
    norm.includes("i accept") ||
    norm.includes("i agree")
  );
}

function extractAddOns(
  text: string,
  context: BusinessContext
): NonNullable<BookingDraft["addOns"]> {
  const norm = normalizeText(text);
  const selected = context.addOns
    .filter((addOn) => {
      const name = normalizeText(addOn.name);
      return name.length > 0 && (norm.includes(name) || name.split(" ").some((w) => w.length > 3 && norm.includes(w)));
    })
    .slice(0, 4)
    .map((addOn) => ({
      addOnId: addOn.id,
      name: addOn.name,
      quantity: 1,
      selectedTierIndex: getDefaultTierIndex(addOn, context),
    }));

  return selected;
}

function getDefaultTierIndex(
  addOn: BusinessContext["addOns"][number],
  context: BusinessContext
): number | undefined {
  if (addOn.pricingType !== "tiered" || !addOn.tieredPrice?.tiers) return undefined;
  // The pricing service accepts tier index; matching by days is handled there
  // when no explicit tier is selected, but we keep index 0 as the modal default.
  return context ? 0 : undefined;
}

function buildAddOnsResponse(
  context: BusinessContext,
  continuationQuestion?: string
): string {
  if (context.addOns.length === 0) {
    return "I do not have any add-ons loaded right now. " +
      (continuationQuestion ?? "Would you like to continue without add-ons?");
  }

  const lines = context.addOns.slice(0, 8).map((a) => {
    const price =
      a.pricingType === "flat" && a.flatPrice
        ? `£${a.flatPrice.amount.toFixed(2)}${a.flatPrice.isPerDay ? " per day" : ""}`
        : a.pricingType === "tiered"
          ? "tiered price"
          : "price varies";
    return `${a.name}: ${price}`;
  });

  return `Available add-ons are: ${lines.join("; ")}. ${
    continuationQuestion ?? "Would you like any add-ons, or continue without add-ons?"
  }`;
}

async function buildAvailableTimeSlotsResponse(params: {
  draft: BookingDraft;
  context: BusinessContext;
  kind: "pickup" | "return";
  requestedDateISO?: string;
  continuationQuestion?: string;
}): Promise<string> {
  const office = params.context.offices.find((o) => o.id === params.draft.officeId);
  if (!office || !params.draft.officeId) {
    return "I need the pickup office before I can check available times.";
  }

  const dateISO =
    params.requestedDateISO ??
    (params.kind === "pickup"
      ? params.draft.pickupDateISO
      : params.draft.returnDateISO);

  if (!dateISO) {
    return params.kind === "pickup"
      ? "What pickup date should I check available times for?"
      : "What return date should I check available times for?";
  }

  const available = await getAvailableTimeSlots({
    officeId: params.draft.officeId,
    office,
    dateISO,
    kind: params.kind,
  });

  if (!available.date || available.slots.length === 0) {
    return `I could not find any available ${params.kind} times for that date. ${
      params.kind === "pickup"
        ? "What pickup date and time would you like?"
        : "What return date and time would you like?"
    }`;
  }

  const ranges = summarizeTimeSlots(available.slots.map((slot) => slot.time));
  const reserved =
    available.reservedTimes.length > 0
      ? ` Reserved times removed: ${available.reservedTimes.join(", ")}.`
      : "";

  return `Available ${params.kind} times on ${available.date}: ${ranges}.${reserved} ${
    params.kind === "pickup"
      ? "Which pickup time would you like?"
      : "Which return time would you like?"
  }`;
}

function summarizeTimeSlots(times: string[]): string {
  const minutes = [...new Set(times.map(timeToMinutes))]
    .filter((m) => !Number.isNaN(m))
    .sort((a, b) => a - b);
  if (minutes.length === 0) return "none";

  const ranges: string[] = [];
  let start = minutes[0];
  let prev = minutes[0];

  for (const current of minutes.slice(1)) {
    if (current === prev + 15) {
      prev = current;
      continue;
    }
    ranges.push(formatMinuteRange(start, prev));
    start = current;
    prev = current;
  }
  ranges.push(formatMinuteRange(start, prev));

  return ranges.slice(0, 6).join(", ");
}

function formatMinuteRange(start: number, end: number): string {
  return start === end
    ? minutesToTime(start)
    : `${minutesToTime(start)}-${minutesToTime(end)}`;
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function buildTimeFeeResponse(
  draft: BookingDraft,
  context: BusinessContext,
  continuationQuestion?: string
): string {
  const office = context.offices.find((o) => o.id === draft.officeId);
  if (!office || !draft.pickupDateISO || !draft.returnDateISO) {
    return continuationQuestion ?? "I need the office plus pickup and return times before I can explain extension fees.";
  }

  const pickup = new Date(draft.pickupDateISO);
  const ret = new Date(draft.returnDateISO);
  if (isNaN(pickup.getTime()) || isNaN(ret.getTime())) {
    return continuationQuestion ?? "I need valid pickup and return times before I can explain extension fees.";
  }

  const pickupTime = formatLondonTime(pickup);
  const returnTime = formatLondonTime(ret);
  const pickupPolicy = checkOfficeTimePolicy(pickup, pickupTime, office, "pickup");
  const returnPolicy = checkOfficeTimePolicy(ret, returnTime, office, "return");

  const parts: string[] = [];
  if (draft.pricePreview?.extraHours && draft.pricePreview.extraHours > 0) {
    const fullDays = draft.pricePreview.days;
    const coveredUntil = new Date(pickup.getTime() + fullDays * 24 * 60 * 60 * 1000);
    parts.push(
      `The ${draft.pricePreview.extraHours} extra hour${draft.pricePreview.extraHours === 1 ? "" : "s"} come from the rental duration: ${fullDays} full day${fullDays === 1 ? "" : "s"} from pickup at ${pickupTime} covers you until ${formatLondonTime(coveredUntil)} on ${formatLondonDate(coveredUntil)}. Your return is ${returnTime} on ${formatLondonDate(ret)}, so the time after that is charged as extra hours.`
    );
  }

  const pickupPrice = draft.pricePreview?.pickupExtensionPrice ?? pickupPolicy.extensionPrice;
  const returnPrice = draft.pricePreview?.returnExtensionPrice ?? returnPolicy.extensionPrice;

  if (pickupPrice > 0) {
    parts.push(`Pickup at ${pickupTime}: ${pickupPolicy.reason} Charge: £${pickupPrice.toFixed(2)}.`);
  }
  if (returnPrice > 0) {
    parts.push(`Return at ${returnTime}: ${returnPolicy.reason} Charge: £${returnPrice.toFixed(2)}.`);
  }

  const specialPrice = draft.pricePreview?.specialDaysPrice ?? 0;
  if (specialPrice > 0) {
    parts.push(`Special open days during the rental add £${specialPrice.toFixed(2)} according to the office special-day rules.`);
  }

  if (parts.length === 0) {
    parts.push("I do not see an extension fee on the current quote. The selected pickup and return times appear to be inside the available office windows.");
  }

  return `${parts.join(" ")} ${
    continuationQuestion ?? "Shall I confirm this booking?"
  }`;
}
