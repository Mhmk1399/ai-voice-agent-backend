// ─────────────────────────────────────────────────────────────────────────────
// Latency Tracker
// ─────────────────────────────────────────────────────────────────────────────

export class LatencyTracker {
  private marks = new Map<string, number>();
  private measurements = new Map<string, number>();

  mark(name: string): void {
    this.marks.set(name, Date.now());
  }

  measure(name: string, startMark: string, endMark: string): number {
    const start = this.marks.get(startMark);
    const end = this.marks.get(endMark);
    if (start == null || end == null) return 0;
    const ms = end - start;
    this.measurements.set(name, ms);
    return ms;
  }

  get(name: string): number {
    return this.measurements.get(name) ?? 0;
  }

  toRecord(): Record<string, number> {
    return Object.fromEntries(this.measurements);
  }
}
