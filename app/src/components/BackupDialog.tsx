import { useEffect, useRef, useState } from "react";
import { ModalDialog } from "./ModalDialog";
import {
  nativeErrorMessage,
  type BackupPort,
  type BackupState,
} from "../core/history";

export interface BackupDialogSession {
  readonly settings: boolean;
  readonly restoreFocus: () => void;
}
export function BackupDialog({
  port,
  session,
  onClose,
  onSaved,
}: {
  port: BackupPort;
  session: BackupDialogSession;
  onClose: () => void;
  onSaved: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BackupState | null>(null);
  const [interval, setIntervalValue] = useState(15);
  const [directory, setDirectory] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [detach, setDetach] = useState(false);
  const [replaceCredential, setReplaceCredential] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = (): void => {
    if (busy) return;
    onClose();
    queueMicrotask(session.restoreFocus);
  };
  useEffect(() => {
    let active = true;
    let initialized = false;
    const refresh = (): void => {
      void port.status().then(
        (value) => {
          if (active) {
            setState(value);
            if (!initialized) {
              setIntervalValue(value.config.interval_minutes);
              initialized = true;
            }
          }
        },
        (cause) => {
          if (active) setError(nativeErrorMessage(cause));
        },
      );
    };
    refresh();
    const timer = setInterval(refresh, 2_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [port]);
  return (
    <ModalDialog
      dialogRef={root}
      className="backup-dialog"
      focusSurface="backup"
      ariaLabel={session.settings ? "バックアップ設定" : "バックアップ状態"}
      busy={busy}
      initialFocus="first-control"
      onClose={close}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!session.settings || busy) return;
          if (
            (directory || replaceCredential) &&
            (!password || password !== confirmation)
          ) {
            setError("空でないパスワードを同じ内容で2回入力してください");
            return;
          }
          // Every control is disabled during the save. Keep a focusable target
          // for Tab/Escape instead of letting focus fall back to the document.
          root.current?.focus({ preventScroll: true });
          setBusy(true);
          setError("");
          void port
            .settings({
              intervalMinutes: interval,
              additionalDirectory: directory,
              password: directory || replaceCredential ? password : null,
              detach,
            })
            .then(
              () => {
                setPassword("");
                setConfirmation("");
                onSaved();
                onClose();
                queueMicrotask(session.restoreFocus);
              },
              (cause) => {
                setError(nativeErrorMessage(cause));
                setBusy(false);
              },
            );
        }}
      >
        <h2>{session.settings ? "バックアップ設定" : "バックアップ状態"}</h2>
        <p>
          Workspace内の履歴にはパスワードがなく、同じディスクの故障やWorkspace全体の削除には備えられません。過去の削除内容も履歴に残ります。
        </p>
        <dl>
          <dt>ローカル履歴</dt>
          <dd>
            {state?.status.phase || "読み込み中"} ·{" "}
            {state?.status.last_local_capture_at
              ? new Date(state.status.last_local_capture_at).toLocaleString()
              : "未作成"}
          </dd>
          <dt>追加先で保護済みの状態</dt>
          <dd>
            {state?.status.additional_protected_capture_at
              ? new Date(
                  state.status.additional_protected_capture_at,
                ).toLocaleString()
              : "未転送"}
          </dd>
          <dt>転送待ち / 転送機会の期限切れ / 既知の添付欠損</dt>
          <dd>
            {state?.status.pending_copy_count ?? 0} /{" "}
            {state?.status.expired_copy_count ?? 0} /{" "}
            {state?.status.known_missing_count ?? 0}
          </dd>
        </dl>
        {[
          state?.status.local_error,
          state?.status.additional_error,
          state?.status.maintenance_error,
        ]
          .filter(Boolean)
          .map((item, index) => (
            <p role="alert" key={index}>
              {item?.message}
            </p>
          ))}
        {session.settings && (
          <fieldset disabled={busy || !state}>
            <label>
              自動保存間隔（分）
              <input
                type="number"
                min={1}
                max={1440}
                step={1}
                value={interval}
                onChange={(event) =>
                  setIntervalValue(Number(event.target.value))
                }
                required
              />
            </label>
            <p>
              保持: 直近48世代 または 日次30世代 または
              月次12世代。追加先にも独立して適用します。
            </p>
            <p>
              追加保存先:{" "}
              {directory || state?.config.additional?.path || "未設定"}
            </p>
            <button
              type="button"
              disabled={Boolean(state?.config.additional)}
              onClick={() => {
                void port
                  .chooseAdditional()
                  .then((value) => {
                    setDirectory(value);
                    setDetach(false);
                  })
                  .catch((cause) => setError(nativeErrorMessage(cause)));
              }}
            >
              追加保存先を選ぶ
            </button>
            {state?.config.additional && (
              <>
                <button
                  type="button"
                  disabled={detach}
                  onClick={() => setReplaceCredential(true)}
                >
                  既存パスワードを資格情報ストアへ再登録
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={detach}
                    onChange={(event) => {
                      setDetach(event.target.checked);
                      setDirectory(null);
                      setReplaceCredential(false);
                      setPassword("");
                      setConfirmation("");
                    }}
                  />
                  追加保存先を解除（保存済みrepositoryは削除しません）
                </label>
              </>
            )}
            {(directory || replaceCredential) && (
              <>
                <label>
                  パスワード
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
                <label>
                  パスワードを再入力
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </label>
                <p>
                  OS資格情報ストアへ保存します。別PCでの復旧に備え、パスワードを別途保管してください。保存先が同じ物理媒体なら、その媒体の故障には備えられません。
                </p>
              </>
            )}
          </fieldset>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="application-modal-actions">
          {session.settings && (
            <button type="submit" disabled={busy || !state}>
              {busy ? "保存中…" : "設定を保存"}
            </button>
          )}
          <button type="button" disabled={busy} onClick={close}>
            閉じる
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
