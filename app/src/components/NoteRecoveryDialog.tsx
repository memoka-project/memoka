import { useEffect, useRef, useState } from "react";
import { ModalDialog } from "./ModalDialog";
import type { CoreRuntime } from "../core/runtime";
import type {
  NoteRecoveryAction,
  NoteRecoveryPage,
} from "../core/replicated-note-recovery";

export interface NoteRecoverySession {
  readonly noteId: string;
  readonly restoreFocus: () => void;
}
const reasons = {
  deleted: "削除された内容",
  "deleted-parent": "親や列が非表示の内容",
  "incompatible-type": "種類の変更で表示できない内容",
};
function actionLabel(action: NoteRecoveryAction): string {
  if (action.kind === "restore-deletions") return "確認済みの削除を取り消す";
  if (action.kind === "restore-structure") return "表示できる構造へ復旧";
  return "本文を新しい段落へ複製";
}

export function NoteRecoveryDialog({
  runtime,
  session,
  onClose,
}: {
  runtime: CoreRuntime;
  session: NoteRecoverySession;
  onClose: () => void;
}) {
  const [page, setPage] = useState<NoteRecoveryPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const saving = useRef(false);
  useEffect(() => {
    let alive = true,
      sequence = 0;
    const read = () => {
      const request = ++sequence;
      void runtime.noteRecovery(session.noteId, offset).then(
        (next) => {
          if (!alive || request !== sequence) return;
          if (next.total && offset >= next.total)
            setOffset(Math.max(0, offset - 50));
          else setPage(next);
        },
        (cause) => {
          if (alive && request === sequence)
            setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    };
    read();
    let revision = runtime.snapshot().noteContentRevision;
    const unsubscribe = runtime.subscribe((snapshot) => {
      if (snapshot.noteContentRevision === revision) return;
      revision = snapshot.noteContentRevision;
      if (!saving.current) read();
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [runtime, session.noteId, offset, refresh]);

  const close = () => {
    if (saving.current) return;
    onClose();
    queueMicrotask(session.restoreFocus);
  };
  const recover = (action: NoteRecoveryAction) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    void runtime
      .recoverNoteContent(action)
      .then(
        () => {
          setNotice(
            action.kind === "copy-inline"
              ? "本文をノート末尾の段落へ複製しました。保護された元の内容も保持しています。"
              : "復旧処理を保存しました。別の削除や種類の変更が残っている内容は一覧に残ります。",
          );
        },
        (cause) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => {
        saving.current = false;
        setBusy(false);
        setRefresh((value) => value + 1);
      });
  };
  return (
    <ModalDialog
      ariaLabel="保護された内容を復旧"
      focusSurface="note-recovery"
      className="note-recovery-dialog"
      busy={busy}
      onClose={close}
    >
      <h2>保護された内容を復旧</h2>
      <p>
        削除や種類の変更で表示されなくなった内容です。ノート全体の削除はTrashから復元できます。
      </p>
      {!!page?.depthCorrections && (
        <p role="status">
          {page.depthCorrections}
          件のSectionをH6以内の祖先へ表示しています。内容は保持されています。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!page ? (
        <p>読み込み中…</p>
      ) : page.total === 0 ? (
        <p>保護された内容はありません。</p>
      ) : (
        <>
          <p>
            {page.total}件中 {page.offset + 1}–{page.offset + page.items.length}
            件
          </p>
          <ol
            className="note-recovery-items"
            data-modal-scroll
            start={page.offset + 1}
          >
            {page.items.map((item) => (
              <li key={item.entityId}>
                <p>{reasons[item.reason]}</p>
                <pre>{item.preview || "（本文のない構造要素）"}</pre>
                <details>
                  <summary>識別情報</summary>
                  <p>
                    {item.type} · {item.entityId}
                  </p>
                </details>
                {item.action ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => recover(item.action!)}
                  >
                    {actionLabel(item.action)}
                  </button>
                ) : (
                  <p>先に親の内容を復旧してください。</p>
                )}
              </li>
            ))}
          </ol>
          <div className="application-modal-actions">
            <button
              type="button"
              disabled={busy || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              前の50件
            </button>
            <button
              type="button"
              disabled={busy || offset + page.items.length >= page.total}
              onClick={() => setOffset(offset + 50)}
            >
              次の50件
            </button>
          </div>
        </>
      )}
      <div className="application-modal-actions">
        <button type="button" disabled={busy} onClick={close}>
          閉じる
        </button>
      </div>
    </ModalDialog>
  );
}
