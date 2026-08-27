export type ApplicationCommandId =
  | "utility.tree"
  | "workspace.search_trash"
  | "workspace.search_buffers"
  | "utility.outline"
  | "window.split-horizontal"
  | "window.split-vertical"
  | "window.close"
  | "buffer.close"
  | "tab.create"
  | "tab.close"
  | "tab.next"
  | "tab.previous"
  | "editor.paste_markdown"
  | "editor.paste_html"
  | "editor.attach"
  | "workspace.switch"
  | "application.update"
  | "application.version"
  | "application.diagnostics"
  | "application.help";

export interface ApplicationCommandDefinition {
  readonly id: ApplicationCommandId;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
}

export const APPLICATION_COMMANDS: readonly ApplicationCommandDefinition[] = [
  {
    id: "utility.tree",
    name: "tree",
    aliases: [],
    description: "Treeを開く",
  },
  {
    id: "workspace.search_trash",
    name: "trash",
    aliases: [],
    description: "ゴミ箱内のノートを検索する",
  },
  {
    id: "workspace.search_buffers",
    name: "buffers",
    aliases: ["ls"],
    description: "読み込み済みBufferを検索する",
  },
  {
    id: "utility.outline",
    name: "outline",
    aliases: [],
    description: "現在WindowのOutlineを開く",
  },
  {
    id: "window.split-horizontal",
    name: "split",
    aliases: ["sp"],
    description: "現在Windowを上下に分割する",
  },
  {
    id: "window.split-vertical",
    name: "vsplit",
    aliases: ["vs"],
    description: "現在Windowを左右に分割する",
  },
  {
    id: "window.close",
    name: "close",
    aliases: ["clo"],
    description: "現在Windowを閉じる",
  },
  {
    id: "buffer.close",
    name: "bdelete",
    aliases: ["bd"],
    description: "現在Bufferを閉じてWindowを空にする",
  },
  {
    id: "tab.create",
    name: "tabnew",
    aliases: [],
    description: "空のTabPageを開く",
  },
  {
    id: "tab.close",
    name: "tabclose",
    aliases: ["tabc"],
    description: "現在TabPageを閉じる",
  },
  {
    id: "tab.next",
    name: "tabnext",
    aliases: ["tabn"],
    description: "次のTabPageへ移動する",
  },
  {
    id: "tab.previous",
    name: "tabprevious",
    aliases: ["tabp"],
    description: "前のTabPageへ移動する",
  },
  {
    id: "editor.paste_markdown",
    name: "paste-markdown",
    aliases: [],
    description: "ClipboardをMarkdownとして現在位置へ貼り付ける",
  },
  {
    id: "editor.paste_html",
    name: "paste-html",
    aliases: [],
    description: "ClipboardをHTMLとして現在位置へ貼り付ける",
  },
  {
    id: "editor.attach",
    name: "attach",
    aliases: [],
    description: "ファイルを現在位置へ添付する",
  },
  {
    id: "workspace.switch",
    name: "switch-workspace",
    aliases: [],
    description: "別のWorkspaceデータ領域へ切り替える",
  },
  {
    id: "application.update",
    name: "update",
    aliases: [],
    description: "署名済みのMemoka更新を確認・適用する",
  },
  {
    id: "application.version",
    name: "version",
    aliases: ["ver"],
    description: "MemokaとTauriのバージョンを表示する",
  },
  {
    id: "application.diagnostics",
    name: "diagnostics",
    aliases: ["diag"],
    description: "ローカル診断情報とログ保存先を表示する",
  },
  {
    id: "application.help",
    name: "help",
    aliases: [],
    description: "管理Helpノートを同期して開く",
  },
];

export type ApplicationCommandParseResult =
  | { readonly kind: "empty" }
  | {
      readonly kind: "command";
      readonly command: ApplicationCommandDefinition;
    }
  | { readonly kind: "error"; readonly message: string };

export function parseApplicationCommand(
  input: string,
): ApplicationCommandParseResult {
  const source = input.trim().replace(/^:/u, "").trim();
  if (!source) return { kind: "empty" };
  const [name, ...arguments_] = source.split(/\s+/u);
  if (arguments_.length > 0) {
    return {
      kind: "error",
      message: `引数を受け付けないCommandです: ${name}`,
    };
  }
  const normalized = name.toLocaleLowerCase();
  const command = APPLICATION_COMMANDS.find(
    (candidate) =>
      candidate.name === normalized || candidate.aliases.includes(normalized),
  );
  return command
    ? { kind: "command", command }
    : { kind: "error", message: `未対応のCommandです: ${name}` };
}

export function applicationCommandHelp(): string {
  return APPLICATION_COMMANDS.filter(({ id }) => id !== "application.help")
    .map(({ name }) => `:${name}`)
    .join(" · ");
}
