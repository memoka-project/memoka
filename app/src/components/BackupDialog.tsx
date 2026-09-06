import { useEffect, useRef, useState, type ReactNode } from "react";
import { ModalDialog } from "./ModalDialog";
import { EventDateTime } from "./EventDateTime";
import {
  DEFAULT_BACKUP_RETENTION,
  nativeErrorMessage,
  type BackupPort,
  type BackupState,
  type BackupRetention,
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
              status={state.status.destinations[target.id]}
              busy={busy !== null}
              save={save}
              error={error?.key === target.id ? error.message : null}
            />
          ))}
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
          )}
        </>
      ) : (
        <p role="status">読み込み中…</p>
      )}
      <div className="application-modal-actions">
        {busy !== null && <span role="status">設定を保存しています…</span>}
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
  status,
  busy,
  save,
  error,
}: {
  target: BackupDestination;
  status?: BackupDestinationStatus;
  busy: boolean;
  save: Save;
  error: string | null;
}) {
  const [retention, setRetention] = useState(target.retention);
  const [credential, setCredential] = useState(false);
  const [removing, setRemoving] = useState(false);
  return (
    <section className="backup-destination-card" aria-label={target.path}>
      <h4 className="backup-destination-path">{target.path}</h4>
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
          <BackupTime value={status?.protected_capture_at} empty="未転送" />
        </dd>
        <dt>最終転送</dt>
        <dd>
          <BackupTime value={status?.last_copy_at} empty="未転送" />
        </dd>
        <dt>転送待ち / 転送機会の期限切れ</dt>
        <dd>
          {status?.pending_copy_count ?? 0} / {status?.expired_copy_count ?? 0}
        </dd>
      </dl>
      {status?.error && (
        <p role="alert">
          {target.enabled ? "" : "停止前のエラー: "}
          {status.error.message}
        </p>
      )}
      {status?.maintenance_error && (
        <p role="alert">{status.maintenance_error.message}</p>
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
function PasswordForm({
  busy,
  newRepository = false,
  onSubmit,
  onDone,
  onCancel,
  children,
}: {
  busy: boolean;
  newRepository?: boolean;
  onSubmit: (password: string) => Promise<boolean>;
  onDone: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!password || password !== confirmation) {
          setError("空でないパスワードを同じ内容で2回入力してください");
          return;
        }
        setError("");
        void onSubmit(password).then((saved) => {
          if (saved) {
            setPassword("");
            setConfirmation("");
            onDone();
          }
        });
      }}
    >
      <fieldset disabled={busy}>
        {children}
        <label>
          パスワード
          <input
            type="password"
            autoComplete={newRepository ? "new-password" : "current-password"}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label>
          パスワードを再入力
          <input
            type="password"
            autoComplete={newRepository ? "new-password" : "current-password"}
            required
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        <p>
          {newRepository
            ? "OS資格情報ストアへ保存します。復旧に備えパスワードを別途保管してください。"
            : "この保存先の既存パスワードを再登録します。バックアップのパスワードを変更する操作ではありません。"}
        </p>
        {error && <p role="alert">{error}</p>}
        <button type="submit">
          {newRepository ? "保存先を登録" : "パスワードを再登録"}
        </button>{" "}
        <button type="button" onClick={onCancel}>
          取り消す
        </button>
      </fieldset>
    </form>
  );
}
function RetentionFields({
  value,
  previous,
  onChange,
}: {
  value: BackupRetention;
  previous?: BackupRetention;
  onChange: (value: BackupRetention) => void;
}) {
  return (
    <>
      <div className="backup-retention-fields">
        {(
          [
            ["last", "直近"],
            ["daily", "日次"],
            ["monthly", "月次"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}（世代）
            <input
              type="number"
              min={key === "last" ? 1 : 0}
              max={4294967295}
              step={1}
              required
              value={value[key]}
              onChange={(event) =>
                onChange({ ...value, [key]: Number(event.target.value) })
              }
            />
          </label>
        ))}
      </div>
      <p className="backup-setting-hint">
        いずれかの条件に該当する世代を保持します。日次・月次の0は、その条件を無効にします。
      </p>
      {previous &&
        (["last", "daily", "monthly"] as const).some(
          (key) => value[key] < previous[key],
        ) && (
          <p className="backup-retention-warning">
            保持数を減らすと、次回の整理で古い世代が削除される場合があります。
          </p>
        )}
    </>
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
        maintaining: "整理中",
        pending: "転送待ち",
        disabled: "無効",
        stopping: "現在の処理が終わり次第停止",
        error: "エラー",
      } as Record<string, string>
    )[phase] ??
    (phase || "待機中")
  );
}
