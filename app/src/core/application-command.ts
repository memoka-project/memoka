import {
  normalizeWorkspaceSearchText,
  workspaceSearchTerms,
} from "./workspace-search";

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
  | "editor.image_width"
  | "workspace.switch"
  | "application.update"
  | "application.version"
  | "application.diagnostics"
  | "application.colorscheme"
  | "application.font"
  | "application.zoom"
  | "application.note_width"
  | "application.line_number_min_width"
  | "application.indent_width"
  | "application.japanese_word_segmentation"
  | "application.japanese_line_break_segmentation"
  | "application.quit"
  | "application.help";

export interface ApplicationCommandDefinition {
  readonly id: ApplicationCommandId;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly argument: "none" | "optional";
}

export const APPLICATION_COMMANDS: readonly ApplicationCommandDefinition[] = [
  {
    id: "utility.tree",
    name: "tree",
    aliases: [],
    description: "Treeを開く",
    argument: "none",
  },
  {
    id: "workspace.search_trash",
    name: "trash",
    aliases: [],
    description: "ゴミ箱内のノートを検索する",
    argument: "none",
  },
  {
    id: "workspace.search_buffers",
    name: "buffers",
    aliases: ["ls"],
    description: "読み込み済みBufferを検索する",
    argument: "none",
  },
  {
    id: "utility.outline",
    name: "outline",
    aliases: [],
    description: "現在WindowのOutlineを開く",
    argument: "none",
  },
  {
    id: "window.split-horizontal",
    name: "split",
    aliases: ["sp"],
    description: "現在Windowを上下に分割する",
    argument: "none",
  },
  {
    id: "window.split-vertical",
    name: "vsplit",
    aliases: ["vs"],
    description: "現在Windowを左右に分割する",
    argument: "none",
  },
  {
    id: "window.close",
    name: "close",
    aliases: ["clo"],
    description: "現在Windowを閉じる",
    argument: "none",
  },
  {
    id: "buffer.close",
    name: "bdelete",
    aliases: ["bd"],
    description: "現在Bufferを閉じてWindowを空にする",
    argument: "none",
  },
  {
    id: "tab.create",
    name: "tabnew",
    aliases: [],
    description: "空のTabPageを開く",
    argument: "none",
  },
  {
    id: "tab.close",
    name: "tabclose",
    aliases: ["tabc"],
    description: "現在TabPageを閉じる",
    argument: "none",
  },
  {
    id: "tab.next",
    name: "tabnext",
    aliases: ["tabn"],
    description: "次のTabPageへ移動する",
    argument: "none",
  },
  {
    id: "tab.previous",
    name: "tabprevious",
    aliases: ["tabp"],
    description: "前のTabPageへ移動する",
    argument: "none",
  },
  {
    id: "editor.paste_markdown",
    name: "paste-markdown",
    aliases: [],
    description: "ClipboardをMarkdownとして現在位置へ貼り付ける",
    argument: "none",
  },
  {
    id: "editor.paste_html",
    name: "paste-html",
    aliases: [],
    description: "ClipboardをHTMLとして現在位置へ貼り付ける",
    argument: "none",
  },
  {
    id: "editor.attach",
    name: "attach",
    aliases: [],
    description: "ファイルを現在位置へ添付する",
    argument: "none",
  },
  {
    id: "editor.image_width",
    name: "image-width",
    aliases: [],
    description: "現在の画像の表示幅を10〜100%で表示・変更する",
    argument: "optional",
  },
  {
    id: "workspace.switch",
    name: "switch-workspace",
    aliases: [],
    description: "別のWorkspaceデータ領域へ切り替える",
    argument: "none",
  },
  {
    id: "application.update",
    name: "update",
    aliases: [],
    description: "署名済みのMemoka更新を確認・適用する",
    argument: "none",
  },
  {
    id: "application.version",
    name: "version",
    aliases: ["ver"],
    description: "MemokaとTauriのバージョンを表示する",
    argument: "none",
  },
  {
    id: "application.diagnostics",
    name: "diagnostics",
    aliases: ["diag"],
    description: "ローカル診断情報とログ保存先を表示する",
    argument: "none",
  },
  {
    id: "application.colorscheme",
    name: "colorscheme",
    aliases: ["colo"],
    description: "Nightfoxカラーテーマを選択・変更する",
    argument: "optional",
  },
  {
    id: "application.font",
    name: "font",
    aliases: [],
    description: "アプリケーション全体のフォントを選択・変更する",
    argument: "none",
  },
  {
    id: "application.zoom",
    name: "zoom",
    aliases: [],
    description: "現在のZoom倍率を表示、または50〜200%の範囲で変更する",
    argument: "optional",
  },
  {
    id: "application.note_width",
    name: "note-width",
    aliases: [],
    description: "ノートの最大表示幅を表示、変更、または解除する",
    argument: "optional",
  },
  {
    id: "application.line_number_min_width",
    name: "line-number-min-width",
    aliases: [],
    description: "行番号を表示するWindowの最小幅を表示・変更する",
    argument: "optional",
  },
  {
    id: "application.indent_width",
    name: "indent-width",
    aliases: [],
    description: "SectionとListに共通のインデント幅を表示・変更する",
    argument: "optional",
  },
  {
    id: "application.japanese_word_segmentation",
    name: "word-segmentation",
    aliases: ["word-segment"],
    description: "日本語word操作の分割方法を表示・変更する",
    argument: "optional",
  },
  {
    id: "application.japanese_line_break_segmentation",
    name: "line-break-segmentation",
    aliases: ["line-break"],
    description: "日本語本文の表示上の分割方法を表示・変更する",
    argument: "optional",
  },
  {
    id: "application.quit",
    name: "quit",
    aliases: ["q", "qa"],
    description: "保存と必要なmirror生成を完了してMemokaを終了する",
    argument: "none",
  },
  {
    id: "application.help",
    name: "help",
    aliases: [],
    description: "管理Helpノートを同期して開く",
    argument: "none",
  },
];

export type ApplicationCommandParseResult =
  | { readonly kind: "empty" }
  | {
      readonly kind: "command";
      readonly command: ApplicationCommandDefinition;
      readonly argument: string | null;
    }
  | { readonly kind: "error"; readonly message: string };

export function parseApplicationCommand(
  input: string,
): ApplicationCommandParseResult {
  const source = input.trim().replace(/^:/u, "").trim();
  if (!source) return { kind: "empty" };
  const [name, ...arguments_] = source.split(/\s+/u);
  const normalized = name.toLocaleLowerCase();
  const command = APPLICATION_COMMANDS.find(
    (candidate) =>
      candidate.name === normalized || candidate.aliases.includes(normalized),
  );
  if (!command) {
    return { kind: "error", message: `未対応のCommandです: ${name}` };
  }
  if (command.argument === "none" && arguments_.length > 0) {
    return {
      kind: "error",
      message: `引数を受け付けないCommandです: ${name}`,
    };
  }
  if (arguments_.length > 1) {
    return {
      kind: "error",
      message: `引数は1つまで指定できます: ${name}`,
    };
  }
  return { kind: "command", command, argument: arguments_[0] ?? null };
}

export function applicationCommandHelp(): string {
  return APPLICATION_COMMANDS.filter(({ id }) => id !== "application.help")
    .map(({ name }) => `:${name}`)
    .join(" · ");
}

export function filterApplicationCommands(
  query: string,
): readonly ApplicationCommandDefinition[] {
  const terms = workspaceSearchTerms(query);
  if (terms.length === 0) return APPLICATION_COMMANDS;
  return APPLICATION_COMMANDS.filter((command) => {
    const searchable = normalizeWorkspaceSearchText(
      [command.name, ...command.aliases, command.description].join(" "),
    );
    return terms.every((term) => searchable.includes(term));
  });
}
