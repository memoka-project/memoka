const INPUT_SAMPLE_LIMIT = 120;
const INPUT_PENDING_LIMIT = 32;
const INPUT_PENDING_MAX_AGE_MS = 2_000;

export interface InputLatencySnapshot {
  readonly lastKey: string | null;
  readonly lastMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
  readonly sampleCount: number;
  readonly slowSampleCount: number;
}

interface PendingInput {
  readonly key: string;
  readonly startedAt: number;
}

type FrameScheduler = (callback: FrameRequestCallback) => number;
type FrameCanceller = (handle: number) => void;

/**
 * Development-only keydown-to-next-paint sampler. Text input is paired by its
 * native `input` event; commands and navigation are paired by the first
 * visible-surface DOM mutation. Debug-line mutations are outside the observed
 * surfaces and cannot complete their own samples.
 */
export class InputLatencyMonitor {
  private readonly samples: number[] = [];
  private readonly pending: PendingInput[] = [];
  private readonly paintBatch: PendingInput[] = [];
  private totalSampleCount = 0;
  private lastKey: string | null = null;
  private lastMs: number | null = null;
  private frame: number | null = null;
  private readonly observer: MutationObserver;

  constructor(
    private readonly root: HTMLElement,
    private readonly now: () => number = () => performance.now(),
    private readonly scheduleFrame: FrameScheduler = (callback) =>
      requestAnimationFrame(callback),
    private readonly cancelFrame: FrameCanceller = (handle) =>
      cancelAnimationFrame(handle),
  ) {
    this.observer = new MutationObserver(this.handleMutations);
    this.root.addEventListener("keydown", this.handleKeyDown, true);
    this.root.addEventListener("input", this.handleInput, true);
    this.observer.observe(this.root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "aria-selected",
        "aria-expanded",
        "data-vim-action",
        "data-vim-mode",
      ],
    });
  }

  snapshot(): InputLatencySnapshot {
    if (this.samples.length === 0) {
      return {
        lastKey: this.lastKey,
        lastMs: this.lastMs,
        p50Ms: null,
        p95Ms: null,
        maxMs: null,
        sampleCount: this.totalSampleCount,
        slowSampleCount: 0,
      };
    }
    const sorted = [...this.samples].sort((left, right) => left - right);
    return {
      lastKey: this.lastKey,
      lastMs: this.lastMs,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      maxMs: sorted.at(-1) ?? null,
      sampleCount: this.totalSampleCount,
      slowSampleCount: this.samples.filter((sample) => sample >= 50).length,
    };
  }

  destroy(): void {
    this.root.removeEventListener("keydown", this.handleKeyDown, true);
    this.root.removeEventListener("input", this.handleInput, true);
    this.observer.disconnect();
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.pending.length = 0;
    this.paintBatch.length = 0;
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (isModifierOnlyKey(event.key)) return;
    const startedAt = this.now();
    while (
      this.pending.length > 0 &&
      startedAt - this.pending[0]!.startedAt > INPUT_PENDING_MAX_AGE_MS
    ) {
      this.pending.shift();
    }
    this.pending.push({ key: displayKey(event.key), startedAt });
    if (this.pending.length > INPUT_PENDING_LIMIT) this.pending.shift();
  };

  private readonly handleInput = (): void => {
    this.markPendingInputsApplied();
  };

  private readonly handleMutations = (
    records: readonly MutationRecord[],
  ): void => {
    if (!records.some(isVisibleInputMutation)) return;
    this.markPendingInputsApplied();
  };

  private markPendingInputsApplied(): void {
    if (this.pending.length === 0) return;
    const observedAt = this.now();
    for (const input of this.pending.splice(0)) {
      if (observedAt - input.startedAt <= INPUT_PENDING_MAX_AGE_MS) {
        this.paintBatch.push(input);
      }
    }
    if (this.paintBatch.length === 0 || this.frame !== null) return;
    this.frame = this.scheduleFrame(() => {
      this.frame = null;
      const paintedAt = this.now();
      for (const input of this.paintBatch.splice(0)) {
        this.record(input.key, Math.max(0, paintedAt - input.startedAt));
      }
    });
  }

  private record(key: string, durationMs: number): void {
    this.lastKey = key;
    this.lastMs = durationMs;
    this.totalSampleCount += 1;
    this.samples.push(durationMs);
    if (this.samples.length > INPUT_SAMPLE_LIMIT) this.samples.shift();
  }
}

function isVisibleInputMutation(record: MutationRecord): boolean {
  const target =
    record.target instanceof Element
      ? record.target
      : record.target.parentElement;
  if (!target || target.closest(".debug-line")) return false;
  return Boolean(
    target.closest(
      ".application-workspace, .application-tab-bar, .application-commandline, .search-pane, .internal-link-picker",
    ),
  );
}

function isModifierOnlyKey(key: string): boolean {
  return [
    "Alt",
    "AltGraph",
    "CapsLock",
    "Control",
    "Meta",
    "NumLock",
    "ScrollLock",
    "Shift",
  ].includes(key);
}

function displayKey(key: string): string {
  if (key === " ") return "Space";
  return key.length > 12 ? `${key.slice(0, 11)}…` : key;
}

function percentile(sorted: readonly number[], ratio: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.min(index, sorted.length - 1)] ?? null;
}
