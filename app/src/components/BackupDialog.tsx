import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { CloudBackupSettings } from "./CloudBackupSettings";
import { ModalDialog } from "./ModalDialog";
import { BackupNotices } from "./BackupNotices";
import { BackupNoticeContext } from "./backup-notice-context";
import { backupStageLabels, phaseLabel } from "../core/backup-display";
import {
  LocalBackupDetails,
  BackupDestinationDetails,
  NewDestination,
  BackupTime,
  type Save,
} from "./BackupDestinationDetails";
import {
  backupDestinationLabel,
  nativeErrorMessage,
  type BackupPort,
  type BackupState,
  type BackupSettingsRequest,
  type BackupGenerationCounts,
} from "../core/history";

export interface BackupDialogSession {
  readonly restoreFocus: () => void;
}
type Tab = "progress" | "settings";
type View =
  { kind: "list" } | { kind: "detail"; id: string; tab: Tab } | { kind: "add" };
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
  const mounted = useRef(false),
    saving = useRef(false);
  const [state, setState] = useState<BackupState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(
    null,
  );
  const [view, setView] = useState<View>({ kind: "list" });
  const [connections, setConnections] = useState(false);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [dirtyForms, setDirtyForms] = useState<ReadonlySet<string>>(new Set());
  const dirty = dirtyForms.size > 0;
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const reportNotice = useCallback((id: string, message: string | null) => {
    setNotices((current) => {
      if ((current[id] ?? null) === message) return current;
      const next = { ...current };
      if (message === null) delete next[id];
      else next[id] = message;
      return next;
    });
  }, []);
  const refreshSequence = useRef(0);
  const focusAfterNavigation = useRef<string | null>(null);
  const returnTo = useRef("add"),
    addedId = useRef<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    let polling = false;
    const refresh = () => {
      if (polling || saving.current) return;
      polling = true;
      const sequence = ++refreshSequence.current;
      void port
        .status()
        .then(
          (value) => {
            if (mounted.current && sequence === refreshSequence.current) {
              setState(value);
              setError((current) =>
                current?.key === "status" ? null : current,
              );
            }
          },
          (cause) => {
            if (mounted.current && sequence === refreshSequence.current)
              setError({ key: "status", message: nativeErrorMessage(cause) });
          },
        )
        .finally(() => {
          polling = false;
        });
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [port]);
  useLayoutEffect(() => {
    const key = focusAfterNavigation.current;
    if (!key) return;
    const target = Array.from(
      root.current?.querySelectorAll<HTMLElement>("[data-backup-focus]") ?? [],
    ).find(
      (element) =>
        element.dataset.backupFocus === key && !element.closest("[hidden]"),
    );
    (target ?? root.current)?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    focusAfterNavigation.current = null;
  }, [view, connections, state, busy]);

  const finishClose = () => {
    onClose();
    queueMicrotask(session.restoreFocus);
  };
  const navigate = (action: () => void) => {
    if (saving.current) return;
    if (dirty) setLeave(() => action);
    else action();
  };
  const showList = (focus = returnTo.current) => {
    setView({ kind: "list" });
    setDirtyForms(new Set());
    setNotice(null);
    focusAfterNavigation.current = focus;
  };
  const back = () => {
    if (saving.current) return;
    if (leave) {
      setLeave(null);
      return;
    }
    if (connections) {
      setConnections(false);
      setConnectionRevision((value) => value + 1);
      focusAfterNavigation.current = "connections";
    } else if (view.kind === "list") navigate(finishClose);
    else navigate(() => showList());
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
      if (!mounted.current) return true;
      setDirtyForms((current) => {
        const next = new Set(current);
        if (request.kind === "local" || request.kind === "retention")
          next.delete(request.kind);
        else if (
          ["credential", "add", "add-google-drive"].includes(request.kind)
        )
          next.delete("password");
        return next;
      });
      setNotice("設定を保存しました");
      try {
        const sequence = ++refreshSequence.current;
        const value = await port.status();
        if (mounted.current && sequence === refreshSequence.current) {
          addedId.current =
            value.config.destinations.find(
              (target) =>
                !state?.config.destinations.some((old) => old.id === target.id),
            )?.id ?? null;
          setState(value);
        }
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
      if (mounted.current) {
        setBusy(null);
        focusAfterNavigation.current =
          view.kind === "detail" ? view.tab : "add";
      }
    }
  };
  const selected =
    view.kind === "detail" && view.id !== "local-history"
      ? state?.config.destinations.find((target) => target.id === view.id)
      : undefined;
  const openDetail = (id: string, tab: Tab) => {
    returnTo.current = id + ":" + tab;
    focusAfterNavigation.current = tab;
    setView({ kind: "detail", id, tab });
    setNotice(null);
  };
  const openConnections = () => {
    focusAfterNavigation.current = "connections-title";
    setConnections(true);
  };
  const added = () =>
    showList(addedId.current ? addedId.current + ":settings" : "add");

  useLayoutEffect(() => {
    if (leave)
      root.current
        ?.querySelector<HTMLElement>(".backup-leave-confirmation button")
        ?.focus({ preventScroll: true });
  }, [leave]);

  return (
    <BackupNoticeContext.Provider value={reportNotice}>
      <ModalDialog
        dialogRef={root}
        className="backup-dialog"
        focusSurface="backup"
        ariaLabel="バックアップ設定"
        busy={busy !== null}
        initialFocus="first-control"
        onClose={back}
      >
        <header className="backup-dialog-header" inert={leave !== null}>
          <h2>
            {connections
              ? "Google接続の管理"
              : view.kind === "add"
                ? "保存先を追加"
                : view.kind === "detail"
                  ? "保存先の詳細"
                  : "バックアップ設定"}
          </h2>
          {view.kind === "list" && !connections && (
            <button
              type="button"
              disabled={!state || busy !== null}
              data-backup-focus="add"
              onClick={() => {
                returnTo.current = "add";
                focusAfterNavigation.current = "kind";
                setView({ kind: "add" });
              }}
            >
              保存先を追加
            </button>
          )}
        </header>
        {error?.key === "status" && <p role="alert">{error.message}</p>}
        {notice && (
          <p role="status" className="backup-save-message">
            {notice}
          </p>
        )}
        <div
          className="backup-dialog-body"
          inert={leave !== null}
          data-modal-scroll
          onChangeCapture={(event) => {
            if (
              event.target instanceof HTMLInputElement &&
              event.target.form &&
              !connections
            ) {
              const key = event.target.form.dataset.backupDraft ?? "password";
              setDirtyForms((current) => new Set([...current, key]));
            }
          }}
        >
          {!state ? (
            <p role="status">読み込み中…</p>
          ) : (
            <>
              <div
                className="backup-overview"
                hidden={view.kind !== "list" || connections}
              >
                <BackupOverview state={state} onDetail={openDetail} />
              </div>
              <div hidden={connections}>
                {view.kind === "detail" && (
                  <>
                    <h3 className="backup-detail-title">
                      {view.id === "local-history"
                        ? "ローカル履歴"
                        : selected
                          ? backupDestinationLabel(selected)
                          : "保存先が解除されました"}
                    </h3>
                    <div
                      className="backup-detail-tabs"
                      role="tablist"
                      aria-label="保存先の詳細"
                    >
                      {(["progress", "settings"] as const).map((tab) => (
                        <button
                          type="button"
                          key={tab}
                          role="tab"
                          id={"backup-tab-" + tab}
                          aria-controls={"backup-panel-" + tab}
                          aria-selected={view.tab === tab}
                          tabIndex={view.tab === tab ? 0 : -1}
                          data-backup-focus={tab}
                          disabled={busy !== null}
                          onKeyDown={(event) => {
                            if (
                              [
                                "ArrowLeft",
                                "ArrowRight",
                                "Home",
                                "End",
                              ].includes(event.key)
                            ) {
                              event.preventDefault();
                              const next =
                                event.key === "Home"
                                  ? "progress"
                                  : event.key === "End"
                                    ? "settings"
                                    : view.tab === "progress"
                                      ? "settings"
                                      : "progress";
                              focusAfterNavigation.current = next;
                              setView({ ...view, tab: next });
                            }
                          }}
                          onClick={() => {
                            focusAfterNavigation.current = tab;
                            setView({ ...view, tab });
                          }}
                        >
                          {tab === "progress" ? "進捗" : "設定"}
                        </button>
                      ))}
                    </div>
                    {view.id === "local-history" ? (
                      <LocalBackupDetails
                        port={port}
                        state={state}
                        busy={busy !== null}
                        save={save}
                        tab={view.tab}
                        error={error?.key === "local" ? error.message : null}
                      />
                    ) : (
                      selected && (
                        <BackupDestinationDetails
                          key={selected.id}
                          target={selected}
                          port={port}
                          status={state.status.destinations[selected.id]}
                          tab={view.tab}
                          busy={busy !== null}
                          save={save}
                          error={
                            error?.key === selected.id ? error.message : null
                          }
                          onRemoved={() => showList("add")}
                          onManageConnections={openConnections}
                        />
                      )
                    )}
                  </>
                )}
                {view.kind === "add" && (
                  <AddBackupDestination
                    port={port}
                    busy={busy !== null}
                    save={save}
                    error={error}
                    onCancel={back}
                    onAdded={added}
                    onManageConnections={openConnections}
                    connectionRevision={connectionRevision}
                  />
                )}
              </div>
              {connections && port.cloud && (
                <CloudBackupSettings
                  mode="connections"
                  cloud={port.cloud}
                  save={save}
                  busy={busy !== null}
                  error={null}
                  onConnected={() => {
                    void port.scheduleCloud?.();
                  }}
                />
              )}
            </>
          )}
        </div>
        <BackupNotices google={!!port.cloud} messages={notices} />
        <footer className="application-modal-actions">
          {leave ? (
            <div className="backup-leave-confirmation" role="alert">
              <span>未保存の入力を破棄しますか？</span>
              <button
                type="button"
                onClick={() => {
                  const action = leave;
                  setLeave(null);
                  setDirtyForms(new Set());
                  action();
                }}
              >
                破棄して戻る
              </button>
              <button
                type="button"
                onClick={() => {
                  setLeave(null);
                  root.current?.focus();
                }}
              >
                編集を続ける
              </button>
            </div>
          ) : (
            <>
              {busy !== null && (
                <span role="status">設定を保存しています…</span>
              )}
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
              <button type="button" disabled={busy !== null} onClick={back}>
                {view.kind === "list" && !connections ? "閉じる" : "戻る"}
              </button>
            </>
          )}
        </footer>
      </ModalDialog>
    </BackupNoticeContext.Provider>
  );
}

function GenerationCount({ value }: { value?: BackupGenerationCounts | null }) {
  return (
    <span className="backup-generation-count">
      {value
        ? value.verified + " / " + value.transferred + " / " + value.target
        : "—"}
    </span>
  );
}
function BackupOverview({
  state,
  onDetail,
}: {
  state: BackupState;
  onDetail: (id: string, tab: Tab) => void;
}) {
  const rows = [
    {
      id: "local-history",
      name: "Workspace内",
      kind: "ローカル履歴",
      enabled: true,
      phase: state.status.phase,
      progress: null,
      time: state.status.last_local_capture_at,
      counts: state.status.generation_counts,
      errors: [
        state.status.local_error && "保存エラー",
        state.status.maintenance_error && "保持整理エラー",
      ],
    },
    ...state.config.destinations.map((target) => {
      const status = state.status.destinations[target.id];
      return {
        id: target.id,
        name: backupDestinationLabel(target),
        enabled: target.enabled,
        kind:
          target.location.kind === "google-drive"
            ? "Google Drive"
            : "ローカルディレクトリ",
        phase: status?.phase || (target.enabled ? "pending" : "disabled"),
        progress: status?.progress,
        time: status?.protected_capture_at,
        counts: status?.generation_counts,
        errors: [
          status?.error && "転送エラー",
          status?.verification_error && "検証エラー",
          status?.maintenance_error && "保持整理エラー",
        ],
      };
    }),
  ];
  return (
    <div className="backup-table-scroll" data-modal-scroll>
      <table
        className="backup-destination-table"
        aria-label="バックアップ保存先"
      >
        <thead>
          <tr>
            <th scope="col">種類・保存先</th>
            <th scope="col">状態・工程</th>
            <th scope="col">最終保存（検証済み）</th>
            <th scope="col">
              保存世代<small>検証済み／転送済み／対象</small>
            </th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              aria-label={
                row.id === "local-history" ? "ローカル履歴" : row.name
              }
              data-disabled={!row.enabled}
            >
              <th scope="row">
                <span>{row.kind}</span>
                <small className="backup-location-label" title={row.name}>
                  {row.name}
                </small>
              </th>
              <td>
                <span className="backup-phase">
                  {!row.enabled && row.phase !== "stopping"
                    ? "無効"
                    : phaseLabel(row.phase)}
                </span>
                {row.progress?.running && (
                  <small>{backupStageLabels[row.progress.stage]}</small>
                )}
                {row.errors.filter(Boolean).map((error) => (
                  <small className="backup-row-error" key={String(error)}>
                    {!row.enabled ? "停止前: " : ""}
                    {error}
                  </small>
                ))}
              </td>
              <td>
                <BackupTime
                  value={row.time}
                  empty={row.id === "local-history" ? "未作成" : "未検証"}
                />
              </td>
              <td>
                <GenerationCount value={row.counts} />
              </td>
              <td>
                <div className="backup-row-actions">
                  {(["progress", "settings"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      data-backup-focus={row.id + ":" + tab}
                      onClick={() => onDetail(row.id, tab)}
                    >
                      {tab === "progress" ? "進捗" : "設定"}
                    </button>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddBackupDestination({
  port,
  busy,
  save,
  error,
  onCancel,
  onAdded,
  onManageConnections,
  connectionRevision,
}: {
  port: BackupPort;
  busy: boolean;
  save: Save;
  error: { key: string; message: string } | null;
  onCancel: () => void;
  onAdded: () => void;
  onManageConnections: () => void;
  connectionRevision: number;
}) {
  const [kind, setKind] = useState("local");
  const [directory, setDirectory] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false),
    [choiceError, setChoiceError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <section aria-label="新しい保存先">
      <label>
        追加する保存先の種類
        <select
          data-backup-focus="kind"
          value={kind}
          disabled={busy || choosing}
          onChange={(event) => {
            setKind(event.target.value);
            setChoiceError(null);
          }}
        >
          <option value="local">ローカルディレクトリ</option>
          {port.cloud && <option value="google">Google Drive</option>}
        </select>
      </label>
      {kind === "local" ? (
        <>
          <button
            type="button"
            disabled={busy || choosing}
            onClick={() => {
              setChoosing(true);
              void port
                .chooseAdditional()
                .then(
                  (value) => {
                    if (alive.current && value) {
                      setDirectory(value);
                      setChoiceError(null);
                    }
                  },
                  (cause) => {
                    if (alive.current)
                      setChoiceError(nativeErrorMessage(cause));
                  },
                )
                .finally(() => {
                  if (alive.current) setChoosing(false);
                });
            }}
          >
            {directory ? "ディレクトリを変更" : "ディレクトリを選択"}
          </button>
          {choiceError && <p role="alert">{choiceError}</p>}
          {directory && (
            <NewDestination
              key={directory}
              directory={directory}
              busy={busy}
              save={save}
              error={error?.key === "new" ? error.message : null}
              onCancel={onCancel}
              onAdded={onAdded}
            />
          )}
        </>
      ) : (
        port.cloud && (
          <CloudBackupSettings
            mode="add"
            cloud={port.cloud}
            save={save}
            busy={busy}
            error={error?.key === "google-new" ? error.message : null}
            onConnected={() => {
              void port.scheduleCloud?.();
            }}
            onAdded={onAdded}
            onManageConnections={onManageConnections}
            refreshKey={connectionRevision}
          />
        )
      )}
    </section>
  );
}
