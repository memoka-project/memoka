import { useState } from "react";
import { phaseLabel } from "../core/backup-display";
import { PasswordForm, RetentionFields } from "./BackupFields";
import { CloudDestinationActions } from "./CloudBackupSettings";
import { EventDateTime } from "./EventDateTime";
import { BackupTransferProgress } from "./BackupTransferProgress";
import { BackupLockRecovery } from "./BackupLockRecovery";
import { useBackupNotice } from "./backup-notice-context";
import {
  DEFAULT_BACKUP_RETENTION,
  backupDestinationLabel,
  type BackupPort,
  type BackupState,
  type BackupDestination,
  type BackupDestinationStatus,
  type BackupSettingsRequest,
} from "../core/history";
export type Save = (
  request: BackupSettingsRequest,
  key: string,
) => Promise<boolean>;
export function LocalBackupDetails({
  port,
  state,
  busy,
  save,
  error,
  tab,
}: {
  port: BackupPort;
  state: BackupState;
  busy: boolean;
  save: Save;
  error: string | null;
  tab: "progress" | "settings";
}) {
  const [interval, setIntervalValue] = useState(state.config.interval_minutes);
  const [retention, setRetention] = useState(state.config.local_retention);
  return (
    <section className="backup-destination-card" aria-label="ローカル履歴">
      <div
        role="tabpanel"
        id="backup-panel-progress"
        aria-labelledby="backup-tab-progress"
        hidden={tab !== "progress"}
      >
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
        <BackupLockRecovery port={port} destinationId={null} disabled={busy} />
      </div>
      <div
        role="tabpanel"
        id="backup-panel-settings"
        aria-labelledby="backup-tab-settings"
        hidden={tab !== "settings"}
      >
        <form
          data-backup-draft="local"
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
                onChange={(event) =>
                  setIntervalValue(Number(event.target.value))
                }
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
      </div>
    </section>
  );
}
export function BackupDestinationDetails({
  target,
  port,
  status,
  busy,
  save,
  error,
  tab,
  onRemoved,
  onManageConnections,
}: {
  target: BackupDestination;
  port: BackupPort;
  status?: BackupDestinationStatus;
  busy: boolean;
  save: Save;
  error: string | null;
  tab: "progress" | "settings";
  onRemoved: () => void;
  onManageConnections: () => void;
}) {
  const [retention, setRetention] = useState(target.retention);
  const [credential, setCredential] = useState(false);
  const [removing, setRemoving] = useState(false);
  useBackupNotice(
    "remove",
    removing
      ? "この保存先の登録を解除します。保存済みバックアップは削除しません。"
      : null,
  );
  return (
    <section
      className="backup-destination-card"
      aria-label={backupDestinationLabel(target)}
    >
      <p className="backup-destination-path">
        {target.location.kind === "google-drive"
          ? "Google Drive · "
          : "ローカル · "}
        {backupDestinationLabel(target)}
      </p>
      <div
        role="tabpanel"
        id="backup-panel-progress"
        aria-labelledby="backup-tab-progress"
        hidden={tab !== "progress"}
      >
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
            {status?.pending_copy_count ?? 0} /{" "}
            {status?.expired_copy_count ?? 0}
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
        <BackupLockRecovery
          port={port}
          destinationId={target.id}
          disabled={busy || !!status?.progress?.running}
        />
      </div>
      <div
        role="tabpanel"
        id="backup-panel-settings"
        aria-labelledby="backup-tab-settings"
        hidden={tab !== "settings"}
      >
        <label>
          <input
            type="checkbox"
            checked={target.enabled}
            disabled={busy}
            onChange={(event) => {
              void save(
                {
                  kind: "enabled",
                  id: target.id,
                  enabled: event.target.checked,
                },
                target.id,
              );
            }}
          />
          有効
        </label>
        <form
          data-backup-draft="retention"
          onSubmit={(event) => {
            event.preventDefault();
            void save(
              { kind: "retention", id: target.id, retention },
              target.id,
            );
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
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void save({ kind: "remove", id: target.id }, target.id).then(
                  (saved) => {
                    if (saved) onRemoved();
                  },
                );
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
          <button
            type="button"
            disabled={busy}
            onClick={() => setRemoving(true)}
          >
            保存先を解除
          </button>
        )}
      </div>
      {target.location.kind === "google-drive" && port.cloud && (
        <CloudDestinationActions
          cloud={port.cloud}
          target={target}
          tab={tab}
          busy={busy}
          onManageConnections={onManageConnections}
          onTransfer={() =>
            port.scheduleCloud?.(target.id) ?? Promise.resolve()
          }
        />
      )}
    </section>
  );
}
export function NewDestination({
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
      <p className="backup-destination-path">{directory}</p>
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
export function BackupTime({
  value,
  empty,
}: {
  value?: string | null;
  empty: string;
}) {
  return value ? <EventDateTime value={value} /> : <>{empty}</>;
}
