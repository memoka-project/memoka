import { ModalDialog } from "./ModalDialog";
import {
  backupCopyingDestinations,
  backupDestinationLabel,
} from "../core/history";
import type { ApplicationDepartureProgress } from "../core/application-departure";
export type ApplicationShutdownProgressState = ApplicationDepartureProgress;

export function ApplicationShutdownProgress({
  progress,
  onRetry,
  onCancel,
  onSkip,
  detail,
}: {
  progress: ApplicationShutdownProgressState;
  onRetry: () => void;
  onCancel: () => void;
  onSkip: () => void;
  detail?: string;
}) {
  const failed = progress.stage.endsWith("-error");
  const action =
    progress.kind === "switch-workspace"
      ? "切り替え"
      : progress.kind === "update"
        ? "更新"
        : "終了";
  const canCancel = !["saving", "closing", "cancelling", "resuming"].includes(
    progress.stage,
  );

  return (
    <ModalDialog
      className="application-shutdown-progress"
      focusSurface="shutdown"
      ariaLabel={
        progress.kind === "switch-workspace"
          ? "Workspaceを切り替え"
          : progress.kind === "update"
            ? "更新前の保存"
            : "Memokaを終了"
      }
      busy={!failed}
      compact
      onClose={canCancel ? onCancel : undefined}
    >
      <span className="eyebrow">Memoka</span>
      <h2>{failed ? `${action}前の確認` : `${action}の準備をしています`}</h2>
      {!failed && <progress />}
      <p role="status">{shutdownProgressLabel(progress)}</p>
      {progress.stage === "backup" && (
        <p>
          時間制限を設けず転送の完了を待ちます。Driveの未開始の検証・保持整理は後回しにし、次回起動後も再開します。実行中の検証・整理がある場合は、その処理の終了を待ちます。「
          {action}
          を取り消す」を選ぶと、バックアップを続けたまま編集画面に戻ります。
        </p>
      )}
      {detail && <p>{detail}</p>}
      {progress.error && <p role="alert">{progress.error}</p>}
      {(failed || canCancel) && (
        <div className="application-modal-actions">
          {failed && <button onClick={onRetry}>再試行</button>}
          {canCancel && <button onClick={onCancel}>{action}を取り消す</button>}
          {(progress.stage === "backup" ||
            progress.stage === "backup-error") && (
            <button onClick={onSkip}>
              バックアップを中断して{action}（編集内容は保存済み）
            </button>
          )}
        </div>
      )}
    </ModalDialog>
  );
}

function shutdownProgressLabel(
  progress: ApplicationShutdownProgressState,
): string {
  if (progress.stage === "saving") return "変更を保存しています…";
  if (progress.stage === "resuming")
    return "バックアップを継続して編集画面に戻ります…";
  if (progress.stage === "cancelling")
    return "バックアップを中断し、実行中の処理の終了を待っています…";
  if (progress.stage === "closing")
    return progress.kind === "switch-workspace"
      ? "Workspaceを切り替えています…"
      : progress.kind === "update"
        ? "更新を適用しています…"
        : "終了しています…";
  if (progress.stage === "saving-error")
    return "編集内容を保存できていないため、そのまま続行できません。";
  if (progress.stage === "operation-error")
    return "操作を完了できませんでした。現在のWorkspaceは保持されています。";
  if (progress.stage === "backup-error")
    return "編集内容は保存済みです。履歴の保存または追加先への転送が完了していません。";
  const copying = progress.backup
    ? backupCopyingDestinations(progress.backup)
    : [];
  if (copying.length > 0)
    return `ローカル履歴を保存しました。転送先: ${copying.map(backupDestinationLabel).join(" / ")}`;
  switch (progress.backup?.status.phase) {
    case "capturing":
      return "整合したデータベースと添付を取得しています…";
    case "saving":
      return "ローカル履歴を保存・検証しています…";
    default:
      return "バックアップの完了を待っています…";
  }
}
