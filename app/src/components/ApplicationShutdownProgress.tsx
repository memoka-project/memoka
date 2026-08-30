import { useEffect, useRef } from "react";
import type { PortableMirrorActivitySnapshot } from "../core/portable-mirror";

export interface ApplicationShutdownProgressState {
  readonly stage: "saving" | "mirror" | "closing";
  readonly mirror: PortableMirrorActivitySnapshot | null;
}

export function ApplicationShutdownProgress({
  progress,
}: {
  progress: ApplicationShutdownProgressState;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.focus({ preventScroll: true }), []);

  const completed = progress.mirror?.completedBytes ?? null;
  const total = progress.mirror?.totalBytes ?? null;
  const percent =
    completed !== null && total !== null && total > 0
      ? Math.min(100, Math.round((completed / total) * 100))
      : null;

  return (
    <div
      ref={root}
      className="application-shutdown-overlay focus-surface focus-surface--focused"
      data-memoka-focus-surface="shutdown"
      role="dialog"
      aria-label="Memokaを終了"
      aria-modal="true"
      aria-busy="true"
      tabIndex={0}
      onKeyDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <section className="application-shutdown-progress" role="status">
        <span className="eyebrow">Memoka</span>
        <h2>終了しています</h2>
        <progress {...(percent === null ? {} : { value: percent, max: 100 })} />
        <p>{shutdownProgressLabel(progress, percent)}</p>
      </section>
    </div>
  );
}

function shutdownProgressLabel(
  progress: ApplicationShutdownProgressState,
  percent: number | null,
): string {
  if (progress.stage === "saving") return "変更を保存しています…";
  if (progress.stage === "closing")
    return "保存を完了しました。終了しています…";
  switch (progress.mirror?.phase) {
    case "flushing":
      return "Markdown mirror用の変更を確定しています…";
    case "preparing":
      return "Markdown mirrorを生成しています…";
    case "staging":
      return "Markdown mirrorの書き込みを準備しています…";
    case "uploading":
      return `Markdown mirrorを書き込んでいます${percent === null ? "…" : `… ${percent}%`}`;
    case "committing":
      return "Markdown mirrorを確定しています…";
    default:
      return "Markdown mirrorの完了を待っています…";
  }
}
