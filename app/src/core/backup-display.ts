import type { BackupTransferStage } from "./history";

export const backupStageLabels: Record<BackupTransferStage, string> = {
  connecting: "接続・保存先の確認",
  listing: "転送先の履歴一覧を確認",
  "source-verification": "転送元の世代を検証",
  uploading: "データ転送",
  "target-verification": "転送した世代を検証",
  maintaining: "保持世代の整理",
  "lock-recovery": "失効ロックの自動確認・解除",
  complete: "処理完了",
};
export function phaseLabel(phase: string): string {
  return (
    (
      {
        uninitialized: "未作成",
        idle: "待機中",
        capturing: "取得中",
        "awaiting-sync": "同期データの取得待ち",
        saving: "保存・検証中",
        copying: "転送中",
        verifying: "転送後の検証中",
        "verification-pending": "転送済み・検証待ち",
        maintaining: "整理中",
        pending: "転送待ち",
        disabled: "無効",
        stopping: "現在の処理が終わり次第停止",
        cancelled: "転送を中止しました（保存済み世代は維持）",
        error: "エラー",
      } as Record<string, string>
    )[phase] ??
    (phase || "待機中")
  );
}
