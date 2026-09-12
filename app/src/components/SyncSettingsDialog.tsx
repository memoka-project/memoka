import { useEffect, useRef, useState } from "react";
import { ModalDialog } from "./ModalDialog";
import { formatEventDateTime } from "../core/display-datetime";
import { writeClipboardText } from "../platform/clipboard";
import {
  devicePhase,
  nativeSynchronization,
  synchronizationError,
  type SyncAction,
  type SyncDevice,
  type SyncView,
  type SynchronizationPort,
} from "../platform/synchronization";

export interface SyncSettingsSession {
  restoreFocus: () => void;
}

/** Invitation secrets live only in memory for the open Workspace session. */
export interface SyncInvitation {
  workspaceId: string;
  invitationId: string;
  expiresAt: number;
  code: string;
}

const tabs = [
  { id: "status", label: "状態" },
  { id: "devices", label: "他端末" },
] as const;
type SyncTab = (typeof tabs)[number]["id"];
const tabOrder: SyncTab[] = ["status", "devices"];
type SubScreen =
  | { kind: "listen-edit" }
  | { kind: "peer-address"; deviceId: string }
  | { kind: "revoke"; deviceId: string };

const bytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1048576
      ? `${(value / 1024).toFixed(1)} KiB`
      : `${(value / 1048576).toFixed(1)} MiB`;
const addresses = (value: string) =>
  value
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
const fingerprint = (key: string) => key.match(/.{1,8}/g)?.join(" ") ?? key;
const nowSeconds = () => Math.floor(Date.now() / 1000);

export function SyncSettingsDialog({
  workspaceId,
  session,
  onClose,
  invitation,
  onInvitation,
  prepare,
  port = nativeSynchronization,
}: {
  workspaceId: string;
  session: SyncSettingsSession;
  onClose: () => void;
  invitation: SyncInvitation | null;
  onInvitation: (invitation: SyncInvitation | null) => void;
  prepare?: () => Promise<void>;
  port?: SynchronizationPort;
}) {
  const [view, setView] = useState<SyncView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const bind = "0.0.0.0:0";
  const [tab, setTab] = useState<SyncTab>("status");
  const [screen, setScreen] = useState<SubScreen | null>(null);
  const [addStep, setAddStep] = useState<1 | 2 | 3 | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const active = useRef(true);
  const saving = useRef(false);
  const invitationClaimed = useRef(false);
  const tabRefs = useRef<Record<SyncTab, HTMLButtonElement | null>>({
    status: null,
    devices: null,
  });

  useEffect(() => {
    active.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await port.status();
        if (active.current) setView(next);
      } catch (cause) {
        if (active.current) setError(synchronizationError(cause));
      } finally {
        if (active.current) timer = setTimeout(() => void read(), 1000);
      }
    };
    void read();
    return () => {
      active.current = false;
      clearTimeout(timer);
    };
  }, [port]);

  useEffect(() => {
    let cancelled = false;
    void port.defaultDeviceName().then((suggested) => {
      if (!cancelled && suggested) setName((current) => current || suggested);
    });
    return () => {
      cancelled = true;
    };
  }, [port]);

  const autoInvite = async () => {
    try {
      const candidates = await port.addressCandidates(workspaceId);
      if (candidates.length > 0) {
        await act({ action: "invite", addresses: [candidates[0]!.address] });
      }
    } catch {
      // The next step explains that no invitation is available.
    }
  };

  const selectTab = (next: SyncTab, focus = false) => {
    setTab(next);
    if (focus) tabRefs.current[next]?.focus();
  };
  const moveTab = (current: SyncTab, key: string) => {
    const index = tabOrder.indexOf(current);
    const next =
      key === "Home"
        ? tabOrder[0]
        : key === "End"
          ? tabOrder[tabOrder.length - 1]
          : tabOrder[
              (index + (key === "ArrowLeft" ? -1 : 1) + tabOrder.length) %
                tabOrder.length
            ];
    selectTab(next, true);
  };

  const activeInvitation =
    invitation &&
    invitation.workspaceId === workspaceId &&
    invitation.expiresAt > nowSeconds()
      ? invitation
      : null;

  // Expiry, Workspace switches and a completed approval all clear the secret.
  useEffect(() => {
    if (!invitation) return;
    if (
      invitation.workspaceId !== workspaceId ||
      invitation.expiresAt <= nowSeconds()
    ) {
      onInvitation(null);
      return;
    }
    // Browser timers clamp beyond ~24.8 days; a far-future timestamp would
    // otherwise fire immediately and drop a still-valid invitation.
    const delay = Math.min(
      invitation.expiresAt * 1000 - Date.now() + 100,
      2_000_000_000,
    );
    const timer = setTimeout(() => onInvitation(null), delay);
    return () => clearTimeout(timer);
  }, [invitation, onInvitation, workspaceId]);

  useEffect(() => {
    if (!view || !invitation) return;
    const pending = view.pending.find(
      (candidate) => candidate.invitationId === invitation.invitationId,
    );
    if (pending?.approved) {
      invitationClaimed.current = false;
      onInvitation(null);
      return;
    }
    if (pending) {
      invitationClaimed.current = true;
    } else if (invitationClaimed.current) {
      invitationClaimed.current = false;
      onInvitation(null);
    }
  }, [invitation, onInvitation, view]);

  const act = async (action: SyncAction): Promise<boolean> => {
    if (saving.current) return false;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      if (action.action === "enable") await prepare?.();
      const result = await port.action(workspaceId, action);
      if (active.current) {
        if (
          result?.connectionInfo &&
          result?.invitationId !== undefined &&
          result?.expiresAt !== undefined
        ) {
          invitationClaimed.current = false;
          setCopyState("idle");
          onInvitation({
            workspaceId,
            invitationId: result.invitationId,
            expiresAt: result.expiresAt,
            code: result.connectionInfo,
          });
        }
        setView(await port.status());
      }
      return true;
    } catch (cause) {
      if (active.current) setError(synchronizationError(cause));
      return false;
    } finally {
      saving.current = false;
      if (active.current) setBusy(false);
    }
  };

  const copyInvitation = async () => {
    if (!activeInvitation) return;
    setCopyState("idle");
    const copied = await writeClipboardText(activeInvitation.code);
    if (active.current) setCopyState(copied ? "copied" : "failed");
  };

  const close = () => {
    if (!saving.current) {
      onClose();
      queueMicrotask(session.restoreFocus);
    }
  };
  // Sub-screens own Esc/Ctrl-C: backing out of them returns to the tabs.
  const requestClose = () => {
    if (saving.current) return;
    if (addStep !== null) {
      setAddStep(null);
      return;
    }
    if (screen !== null) {
      setScreen(null);
      return;
    }
    close();
  };
  const configured = view?.config;
  const localDevice = view?.devices.find(
    (device) => device.member.origin.deviceId === configured?.origin.deviceId,
  );
  const selfRevoked = !!(configured && localDevice?.member.revoked);
  const screenDevice =
    screen?.kind === "peer-address" || screen?.kind === "revoke"
      ? view?.devices.find(
          (device) => device.member.origin.deviceId === screen.deviceId,
        )
      : undefined;

  const invitationPanel = (
    <>
      {activeInvitation ? (
        <div className="sync-invitation">
          <label>
            招待コード
            <textarea
              readOnly
              rows={4}
              value={activeInvitation.code}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <div className="application-modal-actions">
            <button type="button" onClick={() => void copyInvitation()}>
              招待コードをコピー
            </button>
          </div>
          <p role="status">
            {copyState === "copied"
              ? "コピーしました"
              : copyState === "failed"
                ? "コピーできませんでした。コードを選択してCtrl-Cでコピーしてください。"
                : `有効期限 ${formatEventDateTime(
                    new Date(activeInvitation.expiresAt * 1000).toISOString(),
                  )}`}
          </p>
        </div>
      ) : (
        <p>有効な招待コードがありません。新しいコードを作成してください。</p>
      )}
    </>
  );

  return (
    <ModalDialog
      ariaLabel="端末間同期"
      focusSurface="sync-settings"
      className="sync-settings-dialog"
      busy={busy}
      onClose={requestClose}
    >
      <h2>端末間同期</h2>
      {(error || view?.error) && (
        <p role="alert">{error ?? view?.error?.message}</p>
      )}
      {!view ? (
        <p>読み込み中…</p>
      ) : screen?.kind === "listen-edit" ? (
        configured ? (
          <ListenEditor
            initial={view.listening ?? bind}
            busy={busy}
            onCancel={() => setScreen(null)}
            onApply={async (value) => {
              const succeeded = await act({ action: "listen", bind: value });
              if (succeeded && active.current) setScreen(null);
            }}
          />
        ) : null
      ) : screen?.kind === "peer-address" && screenDevice ? (
        <PeerAddressEditor
          device={screenDevice}
          busy={busy}
          onCancel={() => setScreen(null)}
          onSave={async (value) => {
            const succeeded = await act({
              action: "addresses",
              deviceId: screenDevice.member.origin.deviceId,
              expectedPublicKey: screenDevice.member.publicKey,
              addresses: addresses(value),
            });
            if (succeeded && active.current) setScreen(null);
          }}
        />
      ) : screen?.kind === "revoke" ? (
        <RevokeConfirm
          name={
            screen.deviceId === configured?.origin.deviceId
              ? "この端末"
              : `「${screenDevice?.member.name ?? "不明な端末"}」`
          }
          busy={busy}
          onCancel={() => setScreen(null)}
          onConfirm={async () => {
            const self = screen.deviceId === configured?.origin.deviceId;
            const expectedPublicKey = self
              ? configured?.publicKey
              : screenDevice?.member.publicKey;
            if (!expectedPublicKey) return;
            const succeeded = await act({
              action: "revoke",
              deviceId: screen.deviceId,
              expectedPublicKey,
            });
            if (succeeded && active.current) setScreen(null);
          }}
        />
      ) : addStep !== null ? (
        <section aria-label="端末を追加" data-modal-scroll>
          <h3>端末を追加</h3>
          <ol className="sync-add-steps">
            <li data-current={addStep === 1}>この端末に名前を付ける</li>
            <li data-current={addStep === 2}>新しい端末で受信</li>
            <li data-current={addStep === 3}>元端末で承認</li>
          </ol>
          {addStep === 1 && (
            <section>
              {configured ? (
                <>
                  <p>この端末は準備済みです。待受は既定値を使います。</p>
                  <div className="application-modal-actions">
                    <button
                      disabled={busy}
                      onClick={() => setAddStep(null)}
                      type="button"
                    >
                      通常の画面に戻る
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setAddStep(2);
                      }}
                      type="button"
                    >
                      次へ
                    </button>
                  </div>
                </>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act({ action: "enable", name, bind }).then(
                      (succeeded) => {
                        if (succeeded && active.current) {
                          void autoInvite().then(() => {
                            if (active.current) setAddStep(2);
                          });
                        }
                      },
                    );
                  }}
                >
                  <label>
                    この端末の名前
                    <input
                      required
                      maxLength={256}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <button disabled={busy || !name.trim()} type="submit">
                    次へ
                  </button>
                </form>
              )}
            </section>
          )}
          {addStep === 2 && (
            <section>
              <h4>新しい端末で受信</h4>
              <p>
                新しい端末で<code>:new-workspace</code>
                を開き、「別端末から受信」を選びます。招待コード・端末名・新しい空の保存先を指定します。
              </p>
              {invitationPanel}
              <p>
                受信の初回と中断後の再開は、新しい端末で別の操作として案内されます。
              </p>
              <div className="application-modal-actions">
                <button
                  disabled={busy}
                  onClick={() => setAddStep(1)}
                  type="button"
                >
                  戻る
                </button>
                <button
                  disabled={busy}
                  onClick={() => setAddStep(3)}
                  type="button"
                >
                  次へ
                </button>
              </div>
            </section>
          )}
          {addStep === 3 && (
            <section>
              <h4>元端末で承認</h4>
              <p>
                新しい端末に表示された名前と鍵の識別情報が一致することを確認してから承認してください。承認後は新しい端末で受信完了を待ち、Workspaceを開きます。
              </p>
              {view.pending.filter((pending) => !pending.approved).length ? (
                view.pending
                  .filter((pending) => !pending.approved)
                  .map((pending) => (
                    <section key={pending.invitationId} className="sync-review">
                      <h5>参加承認待ち: {pending.member.name}</h5>
                      <code>{pending.fingerprint}</code>
                      <p>
                        期限{" "}
                        {formatEventDateTime(
                          new Date(pending.expiresAt * 1000).toISOString(),
                        )}
                      </p>
                      <div className="application-modal-actions">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act({
                              action: "approve",
                              invitationId: pending.invitationId,
                              expectedPublicKey: pending.member.publicKey,
                            })
                          }
                          type="button"
                        >
                          この端末を承認
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act({
                              action: "reject",
                              invitationId: pending.invitationId,
                            })
                          }
                          type="button"
                        >
                          拒否
                        </button>
                      </div>
                    </section>
                  ))
              ) : (
                <p>この端末の承認を待っている要求はありません。</p>
              )}
              <div className="application-modal-actions">
                <button
                  disabled={busy}
                  onClick={() => setAddStep(2)}
                  type="button"
                >
                  戻る
                </button>
                <button
                  disabled={busy}
                  onClick={() => setAddStep(null)}
                  type="button"
                >
                  通常の画面に戻る
                </button>
              </div>
            </section>
          )}
        </section>
      ) : (
        <>
          <div
            className="sync-settings-tabs"
            role="tablist"
            aria-label="同期設定の画面"
          >
            {tabs.map(({ id, label }) => (
              <button
                type="button"
                key={id}
                ref={(element) => {
                  tabRefs.current[id] = element;
                }}
                role="tab"
                id={`sync-tab-${id}`}
                aria-controls={`sync-panel-${id}`}
                aria-selected={tab === id}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => selectTab(id)}
                onKeyDown={(event) => {
                  if (
                    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  ) {
                    event.preventDefault();
                    moveTab(id, event.key);
                  }
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <section
            role="tabpanel"
            id="sync-panel-status"
            aria-labelledby="sync-tab-status"
            hidden={tab !== "status"}
            data-modal-scroll
          >
            {selfRevoked ? (
              <>
                <dl className="sync-status-facts">
                  <div>
                    <dt>状態</dt>
                    <dd>登録解除済み</dd>
                  </div>
                </dl>
                <p>
                  この端末は同期グループから解除されています。接続も配送も行われません。
                </p>
                <div className="application-modal-actions">
                  <button
                    disabled={busy}
                    onClick={() => void act({ action: "reset" })}
                    type="button"
                  >
                    同期を未設定に戻す
                  </button>
                </div>
              </>
            ) : configured ? (
              <>
                <h3>同期の操作</h3>
                <div className="application-modal-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act({ action: "pause", paused: !configured.paused })
                    }
                    type="button"
                  >
                    {configured.paused ? "再開" : "一時停止"}
                  </button>
                  <button
                    disabled={busy || configured.paused}
                    onClick={() => void act({ action: "reconnect" })}
                    type="button"
                  >
                    今すぐ同期
                  </button>
                </div>
                <h3>自端末の状態</h3>
                <dl className="sync-status-facts">
                  <div>
                    <dt>状態</dt>
                    <dd>
                      {configured.paused
                        ? "一時停止中"
                        : view.listening
                          ? "待受中"
                          : "接続準備中"}
                    </dd>
                  </div>
                  <div>
                    <dt>公開鍵の識別情報</dt>
                    <dd>
                      <code>{fingerprint(configured.publicKey)}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>待ち受けアドレス</dt>
                    <dd>
                      {view.listening ?? "未構成"}{" "}
                      <button
                        disabled={busy}
                        onClick={() => setScreen({ kind: "listen-edit" })}
                        type="button"
                      >
                        変更
                      </button>
                    </dd>
                  </div>
                </dl>
                <h3>受信</h3>
                <dl className="sync-status-facts">
                  <div>
                    <dt>最終反映</dt>
                    <dd>
                      {view.local.lastAppliedAt
                        ? formatEventDateTime(view.local.lastAppliedAt)
                        : "未確認"}
                    </dd>
                  </div>
                  <div>
                    <dt>反映待ち</dt>
                    <dd>
                      {view.local.pendingApplyCount}件 (
                      {bytes(view.local.pendingApplyBytes)})
                    </dd>
                  </div>
                  <div>
                    <dt>添付取得待ち</dt>
                    <dd>
                      {view.local.pendingAttachmentCount}件 (
                      {bytes(view.local.pendingAttachmentBytes)})
                    </dd>
                  </div>
                  <div>
                    <dt>検証失敗</dt>
                    <dd>{view.local.quarantinedCount}件</dd>
                  </div>
                </dl>
                {!!view.failures.length && (
                  <section aria-label="検証失敗の詳細">
                    <h4>検証失敗の詳細（先頭50件）</h4>
                    <ul>
                      {view.failures.map(([hash, reason]) => (
                        <li key={`${hash}:${reason}`}>
                          <p>{reason}</p>
                          <code>{hash}</code>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {!!view.attachmentTransfers.length && (
                  <section aria-label="添付取得の詳細">
                    <h4>添付取得の詳細（先頭64件）</h4>
                    <ul>
                      {view.attachmentTransfers.map((transfer) => (
                        <li key={transfer.sha256}>
                          <p>
                            {bytes(transfer.received)} / {bytes(transfer.size)}{" "}
                            · {transfer.error ?? "取得待ち"}
                          </p>
                          <code>{transfer.sha256}</code>
                          {transfer.error && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void act({
                                  action: "retryAttachment",
                                  sha256: transfer.sha256,
                                })
                              }
                              type="button"
                            >
                              この添付を再取得
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <h3>送信</h3>
                <p>送信待ち {view.local.pendingSignatureCount}件</p>
                <div className="application-modal-actions">
                  <button
                    className="sync-danger-button"
                    disabled={busy}
                    onClick={() =>
                      setScreen({
                        kind: "revoke",
                        deviceId: configured.origin.deviceId,
                      })
                    }
                    type="button"
                  >
                    この端末の登録を解除…
                  </button>
                </div>
              </>
            ) : (
              <>
                <dl className="sync-status-facts">
                  <div>
                    <dt>状態</dt>
                    <dd>同期未設定</dd>
                  </div>
                </dl>
                <div className="application-modal-actions">
                  <button
                    disabled={busy}
                    onClick={() => setAddStep(1)}
                    type="button"
                  >
                    このワークスペースを他の端末へ同期する
                  </button>
                </div>
              </>
            )}
          </section>
          <section
            role="tabpanel"
            id="sync-panel-devices"
            aria-labelledby="sync-tab-devices"
            hidden={tab !== "devices"}
            data-modal-scroll
          >
            {selfRevoked ? (
              <p>
                この端末は同期グループから解除されているため、他端末を管理できません。
              </p>
            ) : configured ? (
              <>
                <div className="application-modal-actions">
                  <button
                    disabled={busy}
                    onClick={() => {
                      setAddStep(2);
                      void autoInvite();
                    }}
                    type="button"
                  >
                    端末を追加
                  </button>
                </div>
                {view.pending
                  .filter((pending) => !pending.approved)
                  .map((pending) => (
                    <section key={pending.invitationId} className="sync-review">
                      <h3>参加承認待ち: {pending.member.name}</h3>
                      <p>
                        参加側に表示された名前と鍵の識別情報が一致することを確認してください。
                      </p>
                      <code>{pending.fingerprint}</code>
                      <p>
                        期限{" "}
                        {formatEventDateTime(
                          new Date(pending.expiresAt * 1000).toISOString(),
                        )}
                      </p>
                      <div className="application-modal-actions">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act({
                              action: "approve",
                              invitationId: pending.invitationId,
                              expectedPublicKey: pending.member.publicKey,
                            })
                          }
                          type="button"
                        >
                          この端末を承認
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act({
                              action: "reject",
                              invitationId: pending.invitationId,
                            })
                          }
                          type="button"
                        >
                          拒否
                        </button>
                      </div>
                    </section>
                  ))}
                <section aria-label="他端末" className="sync-device-list">
                  {view.devices
                    .filter(
                      (device) =>
                        device.member.origin.deviceId !==
                        configured.origin.deviceId,
                    )
                    .map((device) => (
                      <PeerDevice
                        key={device.member.origin.deviceId}
                        device={device}
                        frontier={view.local.frontier}
                        paused={configured.paused}
                        busy={busy}
                        onEditAddress={() =>
                          setScreen({
                            kind: "peer-address",
                            deviceId: device.member.origin.deviceId,
                          })
                        }
                        onRevoke={() =>
                          setScreen({
                            kind: "revoke",
                            deviceId: device.member.origin.deviceId,
                          })
                        }
                      />
                    ))}
                </section>
              </>
            ) : (
              <p>
                同期を有効にすると、参加している他端末がここに一覧表示されます。
              </p>
            )}
          </section>
        </>
      )}
      {screen === null && (
        <div className="application-modal-actions">
          <button disabled={busy} onClick={close} type="button">
            閉じる
          </button>
        </div>
      )}
    </ModalDialog>
  );
}

function ListenEditor({
  initial,
  busy,
  onCancel,
  onApply,
}: {
  initial: string;
  busy: boolean;
  onCancel: () => void;
  onApply: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  return (
    <section aria-label="待ち受けアドレスを変更" data-modal-scroll>
      <h3>待ち受けアドレスを変更</h3>
      <p>
        通常は待ち受けアドレスを変更する必要はありません。他のアプリケーションとポートが衝突して利用できないときに変更します。変更した場合は、他の端末側で接続先アドレスの更新が必要です。
      </p>
      <label>
        IPアドレスとUDPポート
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <div className="application-modal-actions">
        <button
          disabled={busy}
          onClick={() => setValue("0.0.0.0:0")}
          type="button"
        >
          自動
        </button>
        <button disabled={busy} onClick={onCancel} type="button">
          キャンセル
        </button>
        <button
          disabled={busy || !value.trim()}
          onClick={() => void onApply(value)}
          type="button"
        >
          変更
        </button>
      </div>
    </section>
  );
}

function PeerAddressEditor({
  device,
  busy,
  onCancel,
  onSave,
}: {
  device: SyncDevice;
  busy: boolean;
  onCancel: () => void;
  onSave: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(device.addresses.join("\n"));
  return (
    <section aria-label="接続先アドレスを変更" data-modal-scroll>
      <h3>接続先アドレスを変更: {device.member.name}</h3>
      <p>
        この端末が接続しに行くアドレスです。相手端末のIPアドレスが変わったときに更新します。公開鍵の識別情報と一致する端末にのみ保存されます。
      </p>
      <label>
        接続先アドレス（複数は改行区切り）
        <textarea
          rows={3}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <div className="application-modal-actions">
        <button disabled={busy} onClick={onCancel} type="button">
          キャンセル
        </button>
        <button
          disabled={busy || !value.trim()}
          onClick={() => void onSave(value)}
          type="button"
        >
          保存
        </button>
      </div>
    </section>
  );
}

function RevokeConfirm({
  name,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <section aria-label="登録解除の確認" data-modal-scroll>
      <h3>登録解除の確認</h3>
      <p>
        {name}
        を同期から削除します。登録を解除すると元に戻すことはできません。渡したデータは相手の端末に残ります。
      </p>
      <div className="application-modal-actions">
        <button disabled={busy} onClick={onCancel} type="button">
          キャンセル
        </button>
        <button
          className="sync-danger-button"
          disabled={busy}
          onClick={() => void onConfirm()}
          type="button"
        >
          解除
        </button>
      </div>
    </section>
  );
}

function PeerDevice({
  device,
  frontier,
  paused,
  busy,
  onEditAddress,
  onRevoke,
}: {
  device: SyncDevice;
  frontier: SyncView["local"]["frontier"];
  paused: boolean;
  busy: boolean;
  onEditAddress: () => void;
  onRevoke: () => void;
}) {
  const member = device.member;
  return (
    <article className="sync-peer">
      <h3>{member.name}</h3>
      <dl className="sync-status-facts">
        <div>
          <dt>接続状態</dt>
          <dd>{devicePhase(device, paused, frontier)}</dd>
        </div>
        <div>
          <dt>公開鍵の識別情報</dt>
          <dd>
            <code>{fingerprint(member.publicKey)}</code>
          </dd>
        </div>
        <div>
          <dt>アドレス</dt>
          <dd>
            {device.addresses.length ? device.addresses.join("、") : "未登録"}{" "}
            {!member.revoked && (
              <button disabled={busy} onClick={onEditAddress} type="button">
                変更
              </button>
            )}
          </dd>
        </div>
        <div>
          <dt>反映待ち</dt>
          <dd>
            相手で未反映（未受信分を含む） {device.pendingAppliedCount}件 ·{" "}
            {bytes(device.pendingBytes)}
            {device.checkpointRequired ? " ＋文書チェックポイント" : ""}
          </dd>
        </div>
        <div>
          <dt>最終反映</dt>
          <dd>
            {device.lastAppliedAt
              ? formatEventDateTime(device.lastAppliedAt)
              : "未確認"}
          </dd>
        </div>
      </dl>
      {device.connection.error && (
        <p role="alert">{device.connection.error.message}</p>
      )}
      {!member.revoked && (
        <div className="application-modal-actions">
          <button
            className="sync-danger-button"
            disabled={busy}
            onClick={onRevoke}
            type="button"
          >
            登録解除…
          </button>
        </div>
      )}
    </article>
  );
}
