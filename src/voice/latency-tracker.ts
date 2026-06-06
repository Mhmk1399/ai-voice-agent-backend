/**
 * LatencyTracker records wall-clock timings for named phases of a single turn.
 *
 * Usage pattern:
 *
 *   const lt = new LatencyTracker();
 *
 *   lt.mark("transcription_start");
 *   await transcribe(...);
 *   lt.mark("transcription_end");
 *   lt.measure("transcriptionMs", "transcription_start", "transcription_end");
 *
 *   console.log(lt.toMetrics()); // { transcriptionMs: 1243 }
 *
 * Uses `performance.now()` (high-resolution monotonic clock) rather than
 * `Date.now()` to avoid wall-clock drift between marks.
 */
export class LatencyTracker {
  private readonly marks = new Map<string, number>();
  private readonly measured = new Map<string, number>();

  /** Record a high-resolution timestamp for this label. */
  mark(label: string): void {
    this.marks.set(label, performance.now());
  }

  /**
   * Compute elapsed milliseconds between two previously set marks
   * and store under measureName.
   * Value is rounded to the nearest integer (ms precision is sufficient).
   */
  measure(measureName: string, startLabel: string, endLabel: string): void {
    const start = this.marks.get(startLabel);
    const end = this.marks.get(endLabel);

    if (start !== undefined && end !== undefined) {
      this.measured.set(measureName, Math.round(end - start));
    }
  }

  /** Export all measurements as a plain object for JSON serialisation. */
  toMetrics(): Record<string, number> {
    return Object.fromEntries(this.measured.entries());
  }
}
