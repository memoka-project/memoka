import { ModalDialog } from "./ModalDialog";
import type {
  ApplicationRelease,
  ApplicationUpdateProgress,
} from "../platform/application-update";

export function ApplicationUpdatePrompt({
  release,
  progress,
  error,
  onConfirm,
  onClose,
}: {
  release: ApplicationRelease;
  progress: ApplicationUpdateProgress | null;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const busy = progress !== null;

  const percent =
    progress?.contentLength && progress.contentLength > 0
      ? Math.min(
          100,
          Math.round((progress.downloadedBytes / progress.contentLength) * 100),
        )
      : null;

  return (
    <ModalDialog
      className="application-update-prompt"
      focusSurface="update"
      ariaLabel="Memokaを更新"
      busy={busy}
      compact
      onClose={busy ? undefined : onClose}
      onKeyDown={(event) => {
        // Enter on the panel confirms as before. On a focused button, leave
        // native activation intact so Enter on Cancel never installs updates.
        if (
          !busy &&
          event.key === "Enter" &&
          event.target === event.currentTarget
        ) {
          event.preventDefault();
          onConfirm();
        }
      }}
    >
      <h2>Memokaを更新</h2>
      <p role="status">
        {progress
          ? progress.phase === "preparing"
            ? `v${release.version}の更新準備中…`
            : progress.phase === "installing"
              ? `v${release.version}をインストール中…`
              : `v${release.version}をダウンロード中${percent === null ? "…" : ` ${percent}%`}`
          : release.canSelfUpdate
            ? `v${release.version}へ更新しますか？ Enter: 更新 / Esc: 取消`
            : `v${release.version}を配布ページで開きますか？ Enter: 開く / Esc: 取消`}
      </p>
      {progress && <progress max={100} value={percent ?? undefined} />}
      {!progress && release.notes && (
        <p className="application-update-notes">{release.notes}</p>
      )}
      {error && <p role="alert">{error}</p>}
      {!busy && (
        <div className="application-modal-actions">
          <button type="button" onClick={onConfirm}>
            {release.canSelfUpdate ? "更新する" : "配布ページを開く"}
          </button>
          <button type="button" onClick={onClose}>
            取り消す
          </button>
        </div>
      )}
    </ModalDialog>
  );
}
