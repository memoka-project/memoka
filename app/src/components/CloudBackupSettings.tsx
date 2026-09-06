import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_BACKUP_RETENTION,
  nativeErrorMessage,
  type BackupDestination,
  type BackupSettingsRequest,
  type CloudAuthStatus,
  type CloudInitIntent,
  type CloudPort,
  type CloudState,
} from "../core/history";
import { PasswordForm, RetentionFields } from "./BackupFields";
import { EventDateTime } from "./EventDateTime";

const terminal = (status: CloudAuthStatus): boolean =>
  ["success", "denied", "expired", "cancelled", "error"].includes(status.phase);
function useAuthorization(cloud: CloudPort, onConnected: () => void) {
  const [status, setStatus] = useState<CloudAuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const current = useRef<CloudAuthStatus | null>(null);
  const mounted = useRef(false);
  const complete = useRef(onConnected);
  useEffect(() => {
    complete.current = onConnected;
  }, [onConnected]);
  useEffect(() => {
    mounted.current = true;
    let polling = false;
    const timer = setInterval(() => {
      const operation = current.current;
      if (!operation || terminal(operation) || polling) return;
      polling = true;
      void cloud
        .authStatus(operation.operation_id)
        .then(
          (value) => {
            if (
              !mounted.current ||
              current.current?.operation_id !== value.operation_id
            )
              return;
            current.current = value;
            setStatus(value);
            if (value.phase === "success") complete.current();
            if (value.error) setError(value.error.message);
          },
          (cause) => {
            if (mounted.current) setError(nativeErrorMessage(cause));
          },
        )
        .finally(() => {
          polling = false;
        });
    }, 400);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      const operation = current.current;
      if (operation && !terminal(operation))
        void cloud.cancelAuth(operation.operation_id).catch(() => undefined);
    };
  }, [cloud]);
  const start = async (
    request: () => Promise<CloudAuthStatus>,
  ): Promise<void> => {
    if (startingRef.current || (current.current && !terminal(current.current)))
      return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const value = await request();
      if (!mounted.current) {
        await cloud.cancelAuth(value.operation_id);
        return;
      }
      current.current = value;
      setStatus(value);
    } catch (cause) {
      if (mounted.current) setError(nativeErrorMessage(cause));
    } finally {
      startingRef.current = false;
      if (mounted.current) setStarting(false);
    }
  };
  const busy = starting || (status !== null && !terminal(status));
  return {
    start,
    busy,
    content: (
      <>
        {status && (
          <p role="status">
            {(
              {
                starting: "接続を準備中…",
                "waiting-browser":
                  "ブラウザでGoogle認可を待っています（5分以内）",
                exchanging: "認可結果を確認中…",
                saving: "暗号化した接続情報を保存中…",
                verifying: "既存の保存先と認証情報を検証中…",
                success:
                  "Google接続を保存しました（バックアップの転送完了ではありません）",
                denied: "Google認可が拒否されました",
                expired: "認証の有効時間が切れました",
                cancelled: "接続を中止しました",
                error: "接続できませんでした",
              } as Record<string, string>
            )[status.phase] ?? status.phase}
          </p>
        )}
        {busy && (
          <button
            type="button"
            onClick={() => {
              if (status)
                void cloud
                  .cancelAuth(status.operation_id)
                  .catch((cause) => setError(nativeErrorMessage(cause)));
            }}
          >
            認証を中止
          </button>
        )}
        {error && <p role="alert">{error}</p>}
      </>
    ),
  };
}

export function CloudBackupSettings({
  allowAdd = true,
  cloud,
  save,
  busy,
  error,
  onConnected,
}: {
  allowAdd?: boolean;
  cloud: CloudPort;
  save: (request: BackupSettingsRequest, key: string) => Promise<boolean>;
  busy: boolean;
  error: string | null;
  onConnected: () => void;
}) {
  const [state, setState] = useState<CloudState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [adding, setAdding] = useState(false);
  const [retention, setRetention] = useState(DEFAULT_BACKUP_RETENTION);
  const [intents, setIntents] = useState<readonly CloudInitIntent[]>([]);
  const [retry, setRetry] = useState("");
  const [revision, setRevision] = useState(0);
  const auth = useAuthorization(cloud, () => {
    setRevision((r) => r + 1);
    onConnected();
  });
  useEffect(() => {
    let alive = true;
    void cloud.list().then(
      (value) => {
        if (alive) {
          setState(value);
          setConnectionId(
            (id) =>
              id ||
              value.connections.find((c) => c.auth_state === "connected")?.id ||
              "",
          );
        }
      },
      (cause) => {
        if (alive) setLoadError(nativeErrorMessage(cause));
      },
    );
    return () => {
      alive = false;
    };
  }, [cloud, revision]);
  useEffect(() => {
    let alive = true;
    if (!connectionId) return;
    void cloud.intents(connectionId).then(
      (values) => {
        if (alive) {
          setIntents(values);
          setRetry((id) =>
            values.some((v) => v.id === id) ? id : (values[0]?.id ?? ""),
          );
        }
      },
      (cause) => {
        if (alive) setLoadError(nativeErrorMessage(cause));
      },
    );
    return () => {
      alive = false;
    };
  }, [cloud, connectionId, error, revision]);
  return (
    <section className="backup-destination-card" aria-label="Google Drive接続">
      <h3>Google Drive（実験的）</h3>
      <p>
        実Googleアカウントでの復旧・長期認証は未検証です。重要なデータは別の保存先にも残してください。
      </p>
      <p>
        明示的に接続するとGoogleへアクセスします。認可は <code>drive.file</code>{" "}
        のみです。これはアプリが扱えるファイルの権限であり、専用フォルダーだけへのOAuth権限ではありません。
      </p>
      {loadError && <p role="alert">{loadError}</p>}
      {state && !state.configured && (
        <p role="status">
          Google接続は未設定です。Desktop OAuth
          clientのJSONをアプリ設定ディレクトリの{" "}
          <code>google-desktop-client.json</code>、または{" "}
          <code>MEMOKA_GOOGLE_OAUTH_CLIENT_FILE</code>{" "}
          の絶対パスへ設定してください。
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void auth.start(() => cloud.connect(name));
        }}
      >
        <label>
          接続の表示名
          <input
            value={name}
            maxLength={200}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={busy || auth.busy || !state?.configured}
        >
          Googleへ新規接続
        </button>
      </form>
      {auth.content}
      {state?.connections.map((connection) => (
        <div key={connection.id} className="cloud-connection-row">
          <strong>{connection.account_display_label || "Google Drive"}</strong>{" "}
          ·{" "}
          {connection.auth_state === "connected" ? "接続済み" : "接続解除済み"}
          {connection.last_verified_at && (
            <p>
              最終認証: <EventDateTime value={connection.last_verified_at} />
            </p>
          )}
          {connection.bindings.length > 0 && (
            <details>
              <summary>利用先 {connection.bindings.length} 件</summary>
              <ul>
                {connection.bindings.map((binding) => (
                  <li key={`${binding.workspace_id}:${binding.destination_id}`}>
                    Workspace <code>{binding.workspace_id}</code> / 保存先{" "}
                    <code>{binding.destination_id}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <button
            type="button"
            disabled={auth.busy || busy || !state.configured}
            onClick={() =>
              void auth.start(() => cloud.reconnect(connection.id))
            }
          >
            再認証
          </button>{" "}
          <button
            type="button"
            disabled={auth.busy || busy}
            onClick={() => {
              void cloud.disconnect(connection.id).then(
                () => setRevision((r) => r + 1),
                (cause) => setLoadError(nativeErrorMessage(cause)),
              );
            }}
          >
            この端末の接続を解除
          </button>
          {connection.bindings.length > 0 &&
            connection.auth_state === "connected" && (
              <details>
                <summary>利用中の保存先も停止して接続を解除する</summary>
                <p>
                  上記のすべての利用先（別Workspaceを含む）の転送と整理が停止します。保存先の登録とDrive上のバックアップは残ります。再開にはこの接続の再認証が必要です。各保存先を個別に解除してから接続を削除することもできます。
                </p>
                <button
                  type="button"
                  disabled={auth.busy || busy}
                  onClick={() => {
                    void cloud.disconnect(connection.id, true).then(
                      () => setRevision((r) => r + 1),
                      (cause) => setLoadError(nativeErrorMessage(cause)),
                    );
                  }}
                >
                  すべての利用先を停止し、この端末の接続を解除
                </button>
              </details>
            )}
        </div>
      ))}
      <p>
        接続解除はGoogleの認可取消やフォルダー削除をしません。利用中の保存先は先に解除してください。
      </p>
      {!adding ? (
        <button
          type="button"
          disabled={
            !allowAdd ||
            busy ||
            !state?.connections.some((c) => c.auth_state === "connected")
          }
          onClick={() => setAdding(true)}
        >
          Google Driveの保存先を追加
        </button>
      ) : (
        <>
          <label>
            Google接続
            <select
              value={connectionId}
              onChange={(event) => setConnectionId(event.target.value)}
            >
              {state?.connections
                .filter((c) => c.auth_state === "connected")
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.account_display_label || "Google Drive"}
                  </option>
                ))}
            </select>
          </label>
          {intents.length > 0 && (
            <label>
              初期化の再開
              <select
                value={retry}
                onChange={(event) => setRetry(event.target.value)}
              >
                <option value="">別の新しい保存先を作る</option>
                {intents.map((intent) => (
                  <option key={intent.id} value={intent.id}>
                    {intent.display_name || intent.id} · {intent.phase}
                  </option>
                ))}
              </select>
            </label>
          )}
          {retry && (
            <p>
              同じ保存先への再試行です。初期化時と同じバックアップパスワードを入力してください。作成済みのDriveフォルダーは取り消しても削除しません。
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          <PasswordForm
            busy={busy || !connectionId}
            newRepository
            onSubmit={(password) =>
              save(
                {
                  kind: "add-google-drive",
                  connectionId,
                  ...(retry ? { retryIntent: retry } : {}),
                  password,
                  retention,
                },
                "google-new",
              )
            }
            onDone={() => {
              setAdding(false);
              setRevision((r) => r + 1);
            }}
            onCancel={() => setAdding(false)}
          >
            <RetentionFields value={retention} onChange={setRetention} />
          </PasswordForm>
        </>
      )}
    </section>
  );
}

export function CloudDestinationActions({
  cloud,
  target,
  onTransfer,
}: {
  cloud: CloudPort;
  target: BackupDestination;
  onTransfer: () => Promise<unknown>;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<Record<string, string> | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const connectionId =
    target.location.kind === "google-drive"
      ? target.location.connection_id
      : null;
  const auth = useAuthorization(cloud, () => {
    void onTransfer().catch((cause) => setMessage(nativeErrorMessage(cause)));
  });
  useEffect(() => {
    let alive = true;
    void cloud
      .list()
      .then((state) => {
        if (alive)
          setLabel(
            state.connections.find((c) => c.id === connectionId)
              ?.account_display_label ?? null,
          );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [cloud, connectionId]);
  return (
    <div className="cloud-destination-actions">
      {label && <p>接続: {label}</p>}
      <p>
        世代の整理で削除したデータはDriveのゴミ箱へ移ります。Driveの使用容量がすぐ減るとは限りません。Memokaはゴミ箱を空にしません。
      </p>
      <button
        type="button"
        disabled={!target.enabled}
        onClick={() =>
          void onTransfer().then(
            () =>
              setMessage(
                "転送を予約しました。登録・予約は転送完了を意味しません。",
              ),
            (cause) => setMessage(nativeErrorMessage(cause)),
          )
        }
      >
        今すぐ転送
      </button>{" "}
      <button
        type="button"
        onClick={() =>
          void cloud.cancelTransfer(target.id).then(
            () =>
              setMessage(
                "転送の中止を要求しました。保存済み世代は維持します。",
              ),
            (cause) => setMessage(nativeErrorMessage(cause)),
          )
        }
      >
        転送を中止
      </button>{" "}
      <button
        type="button"
        disabled={auth.busy || !connectionId}
        onClick={() => {
          if (connectionId)
            void auth.start(() => cloud.reconnect(connectionId));
        }}
      >
        Googleを再認証
      </button>{" "}
      <button
        type="button"
        onClick={() =>
          void cloud
            .recoveryInformation(target.id)
            .then(setRecovery, (cause) => setMessage(nativeErrorMessage(cause)))
        }
      >
        復旧用情報を表示
      </button>
      {auth.content}
      {message && <p role="status">{message}</p>}
      {recovery && (
        <div>
          <pre>{JSON.stringify(recovery, null, 2)}</pre>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(JSON.stringify(recovery, null, 2))
                .then(
                  () =>
                    setMessage(
                      "復旧用情報をコピーしました。バックアップパスワードも別途保管してください。",
                    ),
                  (cause) => setMessage(nativeErrorMessage(cause)),
                )
            }
          >
            復旧用情報をコピー
          </button>
        </div>
      )}
    </div>
  );
}
