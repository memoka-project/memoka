type ErrorRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ErrorRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseError(message: string): ErrorRecord | null {
  try {
    const value: unknown = JSON.parse(
      message.replace(/^invalid input:\s*/, ""),
    );
    return isRecord(value) &&
      typeof value.code === "string" &&
      typeof value.message === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

export function StartupErrorDetails({ error }: { error: string }) {
  const parsed = parseError(error);
  if (!parsed) return <pre className="startup-error__raw">{error}</pre>;

  const migration = parsed.code === "MIGRATION_PREFLIGHT_FAILED";
  const details = isRecord(parsed.details) ? parsed.details : null;
  const documents = Array.isArray(details?.documents)
    ? details.documents.filter(isRecord)
    : [];

  return (
    <div className="startup-error">
      <p>
        {migration
          ? "移行前検査に失敗したため、移行を中止しました。元のWorkspaceは変更していません。"
          : String(parsed.message)}
      </p>
      {migration && documents.length > 0 && (
        <ul className="startup-error__documents" aria-label="移行できない対象">
          {documents.map((document, index) => (
            <li key={index}>
              {typeof document.document_id === "string" && (
                <p>
                  {document.kind === "workspace" ? "Workspace" : "ノート"}
                  {": "}
                  <code>{document.document_id}</code>
                </p>
              )}
              <p>
                理由:{" "}
                {typeof document.message === "string"
                  ? document.message
                  : "具体的な理由が記録されていません。"}
                {typeof document.code === "string" && (
                  <>
                    {" "}
                    (<code>{document.code}</code>)
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
      <details className="startup-error__details">
        <summary>技術的な詳細</summary>
        <pre className="startup-error__raw">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      </details>
    </div>
  );
}
