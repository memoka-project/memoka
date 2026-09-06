import { useEffect, useRef, useState } from "react";
import { PasswordForm, RetentionFields } from "./BackupFields";
import {
  CloudBackupSettings,
  CloudDestinationActions,
} from "./CloudBackupSettings";
import { ModalDialog } from "./ModalDialog";
import { EventDateTime } from "./EventDateTime";
import { BackupTransferProgress } from "./BackupTransferProgress";
import {
  DEFAULT_BACKUP_RETENTION,
  backupDestinationLabel,
  nativeErrorMessage,
  type BackupPort,
  type BackupState,
  type BackupDestination,
  type BackupDestinationStatus,
  type BackupSettingsRequest,
} from "../core/history";

export interface BackupDialogSession {
  readonly restoreFocus: () => void;
}
type Save = (request: BackupSettingsRequest, key: string) => Promise<boolean>;
export function BackupDialog({
  port,
  session,
  onClose,
  onSaved,
}: {
  port: BackupPort;
  session: BackupDialogSession;
  onClose: () => void;
  onSaved: (request: BackupSettingsRequest) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const saving = useRef(false);
  const [state, setState] = useState<BackupState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(
    null,
  );
  const [directory, setDirectory] = useState<string | null>(null);
  const [destinationKind, setDestinationKind] = useState("local");
  const refreshSequence = useRef(0);
  const refresh = async (): Promise<void> => {
    const sequence = ++refreshSequence.current;
    const value = await port.status();
    if (mounted.current && sequence === refreshSequence.current)
      setState(value);
  };
  useEffect(() => {
    mounted.current = true;
    const refresh = (): void => {
      const sequence = ++refreshSequence.current;
      void port.status().then(
        (value) => {
          if (mounted.current && sequence === refreshSequence.current) {
            setState(value);
            setError((current) => (current?.key === "status" ? null : current));
          }
        },
        (cause) => {
          if (mounted.current && sequence === refreshSequence.current)
            setError({ key: "status", message: nativeErrorMessage(cause) });
        },
      );
    };
    refresh();
    const timer = setInterval(refresh, 2_000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [port]);
  const close = (): void => {
    if (saving.current) return;
    onClose();
    queueMicrotask(session.restoreFocus);
  };
  const save: Save = async (request, key) => {
    if (saving.current) return false;
    saving.current = true;
    root.current?.focus({ preventScroll: true });
    setBusy(key);
    setError(null);
    try {
      await port.settings(request);
      onSaved(request);
      // Never report a committed Add as failed just because polling failed.
      try {
        await refresh();
      } catch (cause) {
        if (mounted.current)
          setError({ key: "status", message: nativeErrorMessage(cause) });
      }
      return true;
    } catch (cause) {
      if (mounted.current)
        setError({ key, message: nativeErrorMessage(cause) });
      return false;
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  return (
    <ModalDialog
      dialogRef={root}
      className="backup-dialog"
      focusSurface="backup"
      ariaLabel="バックアップ設定"
      busy={busy !== null}
      initialFocus="first-control"
      onClose={close}
    >
      <h2>バックアップ設定</h2>
      {error?.key === "status" && <p role="alert">{error.message}</p>}
      {state ? (
        <>
          <LocalSettings
            state={state}
            busy={busy !== null}
            save={save}
            error={error?.key === "local" ? error.message : null}
          />
          <h3>追加保存先</h3>
          {state.config.destinations.map((target) => (
            <DestinationSettings
              key={target.id}
              target={target}
              port={port}
              status={state.status.destinations[target.id]}
              busy={busy !== null}
              save={save}
              error={error?.key === target.id ? error.message : null}
            />
          ))}
          {port.cloud && (
            <label>
              追加する保存先の種類
              <select
                value={destinationKind}
                disabled={busy !== null}
                onChange={(event) => setDestinationKind(event.target.value)}
              >
                <option value="local">ローカルディレクトリ</option>
                <option value="google">Google Drive</option>
              </select>
            </label>
          )}
          {directory ? (
            <NewDestination
              key={directory}
              directory={directory}
              busy={busy !== null}
              save={save}
              error={error?.key === "new" ? error.message : null}
              onCancel={() => setDirectory(null)}
              onAdded={() => setDirectory(null)}
            />
          ) : (
            destinationKind === "local" && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  void port
                    .chooseAdditional()
                    .then((value) => {
                      if (mounted.current && value) setDirectory(value);
                    })
                    .catch((cause) => {
                      if (mounted.current)
                        setError({
                          key: "status",
                          message: nativeErrorMessage(cause),
                        });
                    });
                }}
              >
                保存先を追加
              </button>
            )
          )}
          {port.cloud && (
            <CloudBackupSettings
              allowAdd={destinationKind === "google"}
              cloud={port.cloud}
              save={save}
              busy={busy !== null}
              error={error?.key === "google-new" ? error.message : null}
              onConnected={() => {
                void port.scheduleCloud?.();
              }}
            />
          )}
        </>
      ) : (
        <p role="status">読み込み中…</p>
      )}
      <div className="application-modal-actions">
        {busy !== null && <span role="status">設定を保存しています…</span>}
        {busy === "google-new" && (
          <button
            type="button"
            onClick={() => {
              void port
                .cancel()
                .then(() => port.resume())
                .catch((cause) => {
                  if (mounted.current)
                    setError({
                      key: "google-new",
                      message: nativeErrorMessage(cause),
                    });
                });
            }}
          >
            登録と進行中のバックアップを中止（作成済みフォルダーは残す）
          </button>
        )}
        <button type="button" disabled={busy !== null} onClick={close}>
          閉じる
        </button>
      </div>
    </ModalDialog>
  );
}
function LocalSettings({
  state,
  busy,
  save,
  error,
}: {
  state: BackupState;
  busy: boolean;
  save: Save;
  error: string | null;
}) {
  const [interval, setIntervalValue] = useState(state.config.interval_minutes);
  const [retention, setRetention] = useState(state.config.local_retention);
  return (
    <section className="backup-destination-card" aria-label="ローカル履歴">
      <h3>ローカル履歴</h3>
      <dl>
        <dt>状態</dt>
        <dd>{phaseLabel(state.status.phase)}</dd>
        <dt>最終保存</dt>
        <dd>
          <BackupTime
            value={state.status.last_local_capture_at}
            empty="未作成"
          />
        </dd>
        <dt>既知の添付欠損</dt>
        <dd>{state.status.known_missing_count}</dd>
      </dl>
      {state.status.local_error && (
        <p role="alert">{state.status.local_error.message}</p>
      )}
      {state.status.maintenance_error && (
        <p role="alert">{state.status.maintenance_error.message}</p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save(
            { kind: "local", intervalMinutes: interval, retention },
            "local",
          );
        }}
      >
        <fieldset disabled={busy}>
          <label>
            自動保存間隔（分）
            <input
              type="number"
              min={1}
              max={1440}
              step={1}
              required
              value={interval}
              onChange={(event) => setIntervalValue(Number(event.target.value))}
            />
          </label>
          <RetentionFields
            value={retention}
            onChange={setRetention}
            previous={state.config.local_retention}
          />
          {error && <p role="alert">{error}</p>}
          <button type="submit">ローカル設定を保存</button>
        </fieldset>
      </form>
    </section>
  );
}
function DestinationSettings({
  target,
  port,
  status,
  busy,
  save,
  error,
}: {
  target: BackupDestination;
  port: BackupPort;
  status?: BackupDestinationStatus;
  busy: boolean;
  save: Save;
  error: string | null;
}) {
  const [retention, setRetention] = useState(target.retention);
  const [credential, setCredential] = useState(false);
  const [removing, setRemoving] = useState(false);
  return (
    <section
      className="backup-destination-card"
      aria-label={backupDestinationLabel(target)}
    >
      <h4 className="backup-destination-path">
        {target.location.kind === "google-drive"
          ? "Google Drive · "
          : "ローカル · "}
        {backupDestinationLabel(target)}
      </h4>
      <label>
        <input
          type="checkbox"
          checked={target.enabled}
          disabled={busy}
          onChange={(event) => {
            void save(
              { kind: "enabled", id: target.id, enabled: event.target.checked },
              target.id,
            );
          }}
        />
        有効
      </label>
      <dl>
        <dt>状態</dt>
        <dd>
          {phaseLabel(
            status?.phase ?? (target.enabled ? "pending" : "disabled"),
          )}
        </dd>
        <dt>保護済みの世代</dt>
        <dd>
          <BackupTime value={status?.protected_capture_at} empty="未検証" />
        </dd>
        <dt>最終転送</dt>
        <dd>
          <BackupTime value={status?.last_copy_at} empty="未転送" />
        </dd>
        <dt>転送待ち / 転送機会の期限切れ</dt>
        <dd>
          {status?.pending_copy_count ?? 0} / {status?.expired_copy_count ?? 0}
        </dd>
        <dt>転送済み・検証待ち</dt>
        <dd>{status?.pending_verification_count ?? 0} 世代</dd>
      </dl>
      {status?.progress && <BackupTransferProgress value={status.progress} />}
      {!!status?.failure_count && <p>連続失敗回数: {status.failure_count}</p>}
      {status?.next_retry_at && (
        <p>
          再試行予定: <EventDateTime value={status.next_retry_at} />
        </p>
      )}
      {target.location.kind === "google-drive" && port.cloud && (
        <CloudDestinationActions
          cloud={port.cloud}
          target={target}
          onTransfer={() =>
            port.scheduleCloud?.(target.id) ?? Promise.resolve()
          }
        />
      )}
      {status?.error && (
        <p role="alert">
          {target.enabled ? "" : "停止前のエラー: "}
          {status.error.message}
        </p>
      )}
      {status?.maintenance_error && (
        <p role="alert">
          保持整理のエラー（保護済み世代は維持）:{" "}
          {status.maintenance_error.message}
        </p>
      )}
      {status?.verification_error && (
        <p role="alert">
          転送後の検証エラー（未検証の世代は保護済みに含みません）:{" "}
          {status.verification_error.message}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save({ kind: "retention", id: target.id, retention }, target.id);
        }}
      >
        <fieldset disabled={busy}>
          <RetentionFields
            value={retention}
            onChange={setRetention}
            previous={target.retention}
          />
          <button type="submit">保持設定を保存</button>
        </fieldset>
      </form>
      {error && <p role="alert">{error}</p>}
      {credential ? (
        <PasswordForm
          busy={busy}
          onSubmit={(password) =>
            save({ kind: "credential", id: target.id, password }, target.id)
          }
          onDone={() => setCredential(false)}
          onCancel={() => setCredential(false)}
        />
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setCredential(true)}
        >
          既存パスワードを再登録
        </button>
      )}
      {removing ? (
        <div className="backup-remove-confirmation">
          <p>
            この保存先の登録を解除します。保存済みバックアップは削除しません。
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void save({ kind: "remove", id: target.id }, target.id);
            }}
          >
            登録を解除する
          </button>{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => setRemoving(false)}
          >
            取り消す
          </button>
        </div>
      ) : (
        <button type="button" disabled={busy} onClick={() => setRemoving(true)}>
          保存先を解除
        </button>
      )}
    </section>
  );
}
function NewDestination({
  directory,
  busy,
  save,
  error,
  onCancel,
  onAdded,
}: {
  directory: string;
  busy: boolean;
  save: Save;
  error: string | null;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [retention, setRetention] = useState(DEFAULT_BACKUP_RETENTION);
  return (
    <section className="backup-destination-card" aria-label="新しい保存先">
      <h4>新しい保存先</h4>
      <p className="backup-destination-path">{directory}</p>
      <p>このディレクトリ内の専用フォルダーへ保存します。</p>
      {error && <p role="alert">{error}</p>}
      <PasswordForm
        busy={busy}
        newRepository
        onSubmit={(password) =>
          save({ kind: "add", directory, password, retention }, "new")
        }
        onDone={onAdded}
        onCancel={onCancel}
      >
        <RetentionFields value={retention} onChange={setRetention} />
      </PasswordForm>
    </section>
  );
}
function BackupTime({
  value,
  empty,
}: {
  value?: string | null;
  empty: string;
}) {
  return value ? <EventDateTime value={value} /> : <>{empty}</>;
}
function phaseLabel(phase: string): string {
  return (
    (
      {
        uninitialized: "未作成",
        idle: "待機中",
        capturing: "取得中",
        saving: "保存・検証中",
        copying: "転送中",
        verifying: "転送後の検証中",
        "verification-pending": "転送済み・検証待ち",
        maintaining: "整理中",
        pending: "転送待ち",
        disabled: "無効",
        stopping: "現在の処理が終わり次第停止",
        cancelled: "転送を中止しました（保存済み世代は維持）",
        error: "エラー",
      } as Record<string, string>
    )[phase] ??
    (phase || "待機中")
  );
}
