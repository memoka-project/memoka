import { Fragment } from "react";
import type {
  BackupTransferProgress as TransferProgress,
  BackupTransferStage,
  BackupTransferOperation,
} from "../core/history";
import { EventDateTime } from "./EventDateTime";

const stages: Record<BackupTransferStage, string> = {
  connecting: "接続・保存先の確認",
  listing: "転送先の履歴一覧を確認",
  "source-verification": "転送元の世代を検証",
  uploading: "データ転送",
  "target-verification": "転送した世代を検証",
  maintaining: "保持世代の整理",
  complete: "処理完了",
};
const operations: Record<BackupTransferOperation, string> = {
  repository: "リポジトリ情報の確認",
  snapshots: "世代一覧の取得",
  descriptor: "世代情報の読み取り",
  "file-list": "ファイル一覧の検証",
  copy: "世代のコピー",
  forget: "保持世代の選定・整理",
  prune: "不要データの整理",
  check: "整合性検査",
  other: "その他の処理",
};
function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分${seconds % 60}秒`;
}
function bytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function BackupTransferProgress({ value }: { value: TransferProgress }) {
  return (
    <section aria-label="転送の詳細" className="backup-transfer-progress">
      <dl>
        <dt>{value.running ? "現在の工程" : "前回の工程"}</dt>
        <dd>{stages[value.stage] ?? value.stage}</dd>
        {value.total_generations > 0 && (
          <>
            <dt>この工程で処理済みの世代</dt>
            <dd>
              {value.completed_generations} / {value.total_generations} 世代
              <progress
                aria-label="世代の処理"
                value={value.completed_generations}
                max={value.total_generations}
              />
            </dd>
          </>
        )}
        {value.generation_captured_at && (
          <>
            <dt>{value.running ? "処理中の世代" : "処理した世代"}</dt>
            <dd>
              <EventDateTime value={value.generation_captured_at} />
            </dd>
          </>
        )}
        <dt>この処理の経過時間</dt>
        <dd>
          {duration(value.elapsed_ms)}
          {value.running &&
            `（現在の工程: ${duration(value.stage_elapsed_ms)}）`}
        </dd>
        {value.operation && (
          <>
            <dt>実行中の処理</dt>
            <dd>{operations[value.operation] ?? value.operation}</dd>
          </>
        )}
        {value.failed_operation && (
          <>
            <dt>失敗・中断した処理</dt>
            <dd>
              {operations[value.failed_operation] ?? value.failed_operation}
            </dd>
          </>
        )}
        <dt>最後に進捗があった時刻</dt>
        <dd>
          <EventDateTime value={value.last_progress_at} />
        </dd>
        <dt>ファイル通信量（読み書き合計）</dt>
        <dd>
          {value.transport_bytes === null
            ? "未計測"
            : bytes(value.transport_bytes)}
          {value.bytes_per_second !== null &&
            ` · ${bytes(value.bytes_per_second)}/s`}
        </dd>
      </dl>
      <details>
        <summary>診断情報</summary>
        <dl>
          <dt>処理開始</dt>
          <dd>
            <EventDateTime value={value.started_at} />
          </dd>
          <dt>完了したコマンド数</dt>
          <dd>{value.operations_completed}</dd>
          {Object.entries(value.operation_counts).map(([operation, count]) => (
            <Fragment key={operation}>
              <dt>
                {operations[operation as BackupTransferOperation] ?? operation}
              </dt>
              <dd>{count}回</dd>
            </Fragment>
          ))}
          <dt>通信エラー数（内部再試行を含む）</dt>
          <dd>{value.transport_errors}</dd>
        </dl>
        <p>
          転送待ちはノート数ではなく履歴の世代数です。Driveでは転送完了後に検証待ちへ移り、検証が成功した世代だけを保護済みと表示します。通信量は取得できたファイル転送の統計で、進捗率や残り時間ではありません。
        </p>
      </details>
    </section>
  );
}
