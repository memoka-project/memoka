import {
  nativeErrorMessage,
  backupTransferFailures,
  backupDestinationLabel,
  type BackupPort,
  type BackupState,
} from "./history";
import { createUuidV7 } from "./ids";

export type ApplicationDepartureKind = "quit" | "switch-workspace" | "update";
export interface ApplicationDepartureProgress {
  readonly kind: ApplicationDepartureKind;
  readonly stage:
    | "saving"
    | "backup"
    | "stopping"
    | "resuming"
    | "cancelling"
    | "closing"
    | "saving-error"
    | "backup-error"
    | "stopping-error"
    | "operation-error";
  readonly backup: BackupState | null;
  readonly error?: string;
}

interface DepartureOptions {
  readonly kind: ApplicationDepartureKind;
  readonly save: () => Promise<void>;
  readonly backup: Pick<
    BackupPort,
    "status" | "waitTransfers" | "setDeparture"
  > | null;
  readonly controller: {
    pause(): void;
    resume(): void;
    flush(signal?: AbortSignal): Promise<void>;
    cancel(): Promise<void>;
  } | null;
  readonly complete: () => Promise<void>;
}
interface Departure {
  readonly id: string;
  readonly options: DepartureOptions;
  readonly resolve: (completed: boolean) => void;
  progress: ApplicationDepartureProgress;
  coreSaved: boolean;
  action: "wait" | "cancel" | "skip";
  attempt: AbortController | null;
}

/** All departures require durable Core saves. Quit stops/reaps background work
 * without creating a final backup or waiting for upload/verification success.
 * Switching/updating still wait for backup unless explicitly skipped;
 * withdrawing their wait does not cancel a running backup. */
export class ApplicationDeparture {
  private current: Departure | null = null;
  constructor(
    private readonly publish: (
      value: ApplicationDepartureProgress | null,
    ) => void,
    private readonly paint: () => Promise<void> = async () => undefined,
  ) {}
  get active(): boolean {
    return this.current !== null;
  }
  start(options: DepartureOptions): Promise<boolean> {
    if (this.current) return Promise.resolve(false);
    options.controller?.pause();
    return new Promise((resolve) => {
      const session: Departure = {
        id: createUuidV7(),
        options,
        resolve,
        progress: { kind: options.kind, stage: "saving", backup: null },
        coreSaved: false,
        action: "wait",
        attempt: null,
      };
      this.current = session;
      void this.attempt(session);
    });
  }
  private show(
    session: Departure,
    stage: ApplicationDepartureProgress["stage"],
    error?: unknown,
    backup: BackupState | null = null,
  ): void {
    if (this.current !== session) return;
    session.progress = {
      kind: session.options.kind,
      stage,
      backup,
      ...(error === undefined ? {} : { error: nativeErrorMessage(error) }),
    };
    this.publish(session.progress);
  }
  private waiting(session: Departure, attempt: AbortController): boolean {
    return (
      this.current === session &&
      session.action === "wait" &&
      session.attempt === attempt &&
      !attempt.signal.aborted
    );
  }
  private async attempt(session: Departure): Promise<void> {
    if (session.attempt && !session.attempt.signal.aborted) return;
    const attempt = new AbortController();
    session.attempt = attempt;
    session.action = "wait";
    session.coreSaved = false;
    let stage: ApplicationDepartureProgress["stage"] = "saving";
    this.show(session, stage);
    try {
      await this.paint();
      if (session.options.kind !== "quit")
        await session.options.backup?.setDeparture?.(true, session.id);
      await session.options.save();
      session.coreSaved = true;
      if (!this.waiting(session, attempt)) return;
      const { controller, backup } = session.options;
      if (session.options.kind === "quit" && controller) {
        // Do not query a repository or start a final capture on exit. Stop
        // existing work only after Core edits are durable, and retain the
        // native lease until child processes and their lock cleanup finish.
        stage = "stopping";
        this.show(session, stage);
        await this.paint();
        await controller.cancel();
      } else if (controller && backup) {
        stage = "backup";
        this.show(session, stage);
        const timer = setInterval(() => {
          if (!this.waiting(session, attempt)) return;
          void backup
            .status()
            .then((state) => {
              if (
                this.waiting(session, attempt) &&
                session.progress.stage === "backup"
              )
                this.show(session, "backup", undefined, state);
            })
            .catch(() => undefined);
        }, 500);
        const stopPolling = () => clearInterval(timer);
        attempt.signal.addEventListener("abort", stopPolling, { once: true });
        try {
          await this.paint();
          if (!this.waiting(session, attempt)) return;
          await controller.flush(attempt.signal);
          if (this.waiting(session, attempt))
            await backup.waitTransfers?.(session.id);
          if (!this.waiting(session, attempt)) return;
          const state = await backup.status();
          if (!this.waiting(session, attempt)) return;
          const failures = backupTransferFailures(state);
          if (failures.length > 0) {
            this.show(
              session,
              "backup-error",
              `ローカル履歴は保存済みですが、追加先への転送は未完了です: ${failures.map(({ destination, error }) => `${backupDestinationLabel(destination)}: ${error.message}`).join(" / ")}`,
              state,
            );
            return;
          }
        } finally {
          stopPolling();
          attempt.signal.removeEventListener("abort", stopPolling);
        }
      }
      if (this.waiting(session, attempt)) await this.complete(session);
    } catch (error) {
      if (this.waiting(session, attempt))
        this.show(
          session,
          stage === "saving"
            ? "saving-error"
            : stage === "stopping"
              ? "stopping-error"
              : "backup-error",
          error,
        );
    } finally {
      if (session.attempt === attempt) session.attempt = null;
    }
  }
  private async complete(session: Departure): Promise<void> {
    this.show(session, "closing");
    try {
      await this.paint();
      await session.options.complete();
      // A platform/test updater may return without replacing the process.
      if (session.options.kind === "update")
        await session.options.backup?.setDeparture?.(false, session.id);
      this.finish(session, true);
    } catch (error) {
      session.action = "wait";
      this.show(session, "operation-error", error);
    }
  }
  private finish(session: Departure, completed: boolean): void {
    if (this.current !== session) return;
    this.current = null;
    // A successful switch has destroyed the old controller. Resuming that
    // controller would schedule an old-runtime capture against the new path.
    if (!completed) session.options.controller?.resume();
    this.publish(null);
    session.resolve(completed);
  }
  retry(): void {
    const session = this.current;
    if (session && session.progress.stage.endsWith("-error"))
      void this.attempt(session);
  }
  async leave(proceed: boolean): Promise<void> {
    const session = this.current;
    if (
      !session ||
      session.action !== "wait" ||
      ["saving", "closing", "stopping", "cancelling", "resuming"].includes(
        session.progress.stage,
      ) ||
      (proceed &&
        (!session.coreSaved ||
          session.progress.stage === "operation-error" ||
          session.progress.stage === "stopping-error"))
    )
      return;
    const stoppingFailed = session.progress.stage === "stopping-error";
    session.action = proceed ? "skip" : "cancel";
    session.attempt?.abort();
    this.show(session, proceed ? "cancelling" : "resuming");
    try {
      if (proceed) {
        await session.options.controller?.cancel();
        await this.complete(session);
      } else {
        // If stopping timed out, do not reopen background admission before
        // native children are reaped. The local editing state remains intact.
        if (stoppingFailed) await session.options.controller?.cancel();
        // Release only this departure's observer. Cloud copy and verification
        // keep their own cancellation tokens and continue in the background.
        if (session.options.kind !== "quit")
          await session.options.backup?.setDeparture?.(false, session.id);
        this.finish(session, false);
      }
    } catch (error) {
      session.action = "wait";
      this.show(
        session,
        stoppingFailed
          ? "stopping-error"
          : session.coreSaved
            ? "backup-error"
            : "saving-error",
        error,
      );
    }
  }
}
