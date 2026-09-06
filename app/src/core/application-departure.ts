import {
  nativeErrorMessage,
  backupTransferFailures,
  type BackupPort,
  type BackupState,
} from "./history";

export type ApplicationDepartureKind = "quit" | "switch-workspace" | "update";
export interface ApplicationDepartureProgress {
  readonly kind: ApplicationDepartureKind;
  readonly stage:
    | "saving"
    | "backup"
    | "cancelling"
    | "closing"
    | "saving-error"
    | "backup-error"
    | "operation-error";
  readonly backup: BackupState | null;
  readonly error?: string;
}

interface DepartureOptions {
  readonly kind: ApplicationDepartureKind;
  readonly save: () => Promise<void>;
  readonly backup: Pick<BackupPort, "status"> | null;
  readonly controller: {
    pause(): void;
    resume(): void;
    flush(): Promise<void>;
    cancel(): Promise<void>;
  } | null;
  readonly complete: () => Promise<void>;
}
interface Departure {
  readonly options: DepartureOptions;
  readonly resolve: (completed: boolean) => void;
  progress: ApplicationDepartureProgress;
  coreSaved: boolean;
  action: "wait" | "cancel" | "skip";
  running: boolean;
}

/** One save/backup barrier for quit, workspace switching and the updater.
 * Errors remain interactive; only a successful Core save permits skipping
 * backup. Cancellation waits for the native child to be reaped before the
 * caller may close or release the workspace. */
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
        options,
        resolve,
        progress: { kind: options.kind, stage: "saving", backup: null },
        coreSaved: false,
        action: "wait",
        running: false,
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
  private waiting(session: Departure): boolean {
    return this.current === session && session.action === "wait";
  }
  private async attempt(session: Departure): Promise<void> {
    if (session.running) return;
    session.running = true;
    session.action = "wait";
    session.coreSaved = false;
    let stage: ApplicationDepartureProgress["stage"] = "saving";
    this.show(session, stage);
    try {
      await this.paint();
      await session.options.save();
      session.coreSaved = true;
      if (!this.waiting(session)) return;
      const { controller, backup } = session.options;
      if (controller && backup) {
        stage = "backup";
        this.show(session, stage);
        const timer = setInterval(() => {
          void backup
            .status()
            .then((state) => {
              if (this.waiting(session) && session.progress.stage === "backup")
                this.show(session, "backup", undefined, state);
            })
            .catch(() => undefined);
        }, 500);
        try {
          await this.paint();
          if (!this.waiting(session)) return;
          await controller.flush();
          if (!this.waiting(session)) return;
          const state = await backup.status();
          if (!this.waiting(session)) return;
          const failures = backupTransferFailures(state);
          if (failures.length > 0) {
            this.show(
              session,
              "backup-error",
              `ローカル履歴は保存済みですが、追加先への転送は未完了です: ${failures.map(({ destination, error }) => `${destination.path}: ${error.message}`).join(" / ")}`,
              state,
            );
            return;
          }
        } finally {
          clearInterval(timer);
        }
      }
      if (this.waiting(session)) await this.complete(session);
    } catch (error) {
      if (this.waiting(session))
        this.show(
          session,
          stage === "saving" ? "saving-error" : "backup-error",
          error,
        );
    } finally {
      session.running = false;
    }
  }
  private async complete(session: Departure): Promise<void> {
    this.show(session, "closing");
    try {
      await this.paint();
      await session.options.complete();
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
      ["saving", "closing", "cancelling"].includes(session.progress.stage) ||
      (proceed &&
        (!session.coreSaved || session.progress.stage === "operation-error"))
    )
      return;
    session.action = proceed ? "skip" : "cancel";
    this.show(session, "cancelling");
    try {
      await session.options.controller?.cancel();
      if (proceed) await this.complete(session);
      else this.finish(session, false);
    } catch (error) {
      session.action = "wait";
      this.show(
        session,
        session.coreSaved ? "backup-error" : "saving-error",
        error,
      );
    }
  }
}
