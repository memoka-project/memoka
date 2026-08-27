import { useEffect, useRef } from "react";
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
  const root = useRef<HTMLDivElement>(null);
  const busy = progress !== null;

  useEffect(() => root.current?.focus(), []);

  const percent =
    progress?.contentLength && progress.contentLength > 0
      ? Math.min(
          100,
          Math.round((progress.downloadedBytes / progress.contentLength) * 100),
        )
      : null;

  return (
    <div
      ref={root}
      className="application-commandline application-commandline--active application-update-prompt focus-surface focus-surface--focused"
      data-memoka-focus-surface="update"
      role="dialog"
      aria-label="Memokaを更新"
      aria-busy={busy}
      tabIndex={0}
      onKeyDown={(event) => {
        if (busy) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          onConfirm();
        } else if (
          event.key === "Escape" ||
          (event.ctrlKey && event.key.toLocaleLowerCase() === "c")
        ) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <span className="commandline-prompt">:</span>
      <span>
        {progress
          ? progress.phase === "preparing"
            ? `v${release.version}の更新準備中…`
            : progress.phase === "installing"
              ? `v${release.version}をインストール中…`
              : `v${release.version}をダウンロード中${percent === null ? "…" : ` ${percent}%`}`
          : release.canSelfUpdate
            ? `v${release.version}へ更新しますか？ Enter: 更新 / Esc: 取消`
            : `v${release.version}を配布ページで開きますか？ Enter: 開く / Esc: 取消`}
      </span>
      {!progress && release.notes && (
        <span className="application-update-notes">{release.notes}</span>
      )}
      {error && <span className="commandline-error">{error}</span>}
    </div>
  );
}
