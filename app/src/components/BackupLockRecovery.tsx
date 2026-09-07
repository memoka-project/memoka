import { useEffect, useRef, useState } from "react";
import {
  nativeErrorMessage,
  type BackupLockReport,
  type BackupPort,
} from "../core/history";
import { EventDateTime } from "./EventDateTime";
import { useBackupNotice } from "./backup-notice-context";

export function BackupLockRecovery({
  port,
  destinationId,
  disabled,
}: {
  port: BackupPort;
  destinationId: string | null;
  disabled: boolean;
}) {
  const [report, setReport] = useState<BackupLockReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(false),
    running = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useBackupNotice(
    "repository-locks",
    confirm
      ? "使用中のバックアップ処理がないことを確認してください。Resticが失効と判定したロックだけを解除します。使用中のロックの強制解除や、保存済み世代の削除は行いません。"
      : null,
  );
  const run = async (repair: boolean) => {
    if (!port.repositoryLocks || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setConfirm(false);
    try {
      const value = await port.repositoryLocks(destinationId, repair);
      if (alive.current) setReport(value);
    } catch (cause) {
      if (alive.current) {
        setError(nativeErrorMessage(cause));
        setReport(null);
      }
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  };
  if (!port.repositoryLocks) return null;
  return (
    <section
      className="backup-lock-recovery"
      aria-label="ロックの復旧"
      aria-busy={busy}
    >
      <h4>ロックの確認・復旧</h4>
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => void run(false)}
      >
        {busy ? "処理中…" : "ロックを確認"}
      </button>
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          <p role="status">
            {report.unlock_attempted
              ? "失効ロックの解除処理が完了しました。"
              : ""}
            現在のロック: {report.locks.length} 件
            {report.unlock_attempted &&
              (report.locks.length === 0
                ? "。バックアップを再試行できます。"
                : "。残っているロックは解除しませんでした。処理の終了を待ってから再確認してください。")}
          </p>
          {report.locks.length > 0 && (
            <>
              <div className="backup-table-scroll" data-modal-scroll>
                <table
                  className="backup-lock-table"
                  aria-label="保存先のロック"
                >
                  <thead>
                    <tr>
                      <th>端末 / PID</th>
                      <th>ロック更新日時</th>
                      <th>種類</th>
                      <th>ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.locks.map((lock) => (
                      <tr key={lock.id}>
                        <td>
                          {lock.hostname} / {lock.pid}
                        </td>
                        <td>
                          <EventDateTime value={lock.time} />
                        </td>
                        <td>{lock.exclusive ? "排他" : "共有"}</td>
                        <td>
                          <code title={lock.id}>{lock.id.slice(0, 12)}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {confirm ? (
                <div className="backup-lock-confirmation">
                  <button
                    type="button"
                    disabled={disabled || busy}
                    onClick={() => void run(true)}
                  >
                    失効ロックのみ解除する
                  </button>
                  <button type="button" onClick={() => setConfirm(false)}>
                    取り消す
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={disabled || busy}
                  onClick={() => setConfirm(true)}
                >
                  失効したロックを解除…
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
