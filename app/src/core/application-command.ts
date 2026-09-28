import {
  normalizeWorkspaceSearchText,
  workspaceSearchTerms,
} from "./workspace-search";
import {
  normalizeApplicationFontFamily,
  normalizeApplicationIndentWidthPx,
  normalizeApplicationLineNumberMinWidthPx,
  normalizeApplicationNoteMaxWidthPx,
  normalizeApplicationZoomPercent,
  normalizeNoteGapEm,
  normalizeNoteLineHeight,
  normalizeNoteSectionTitleSizeEm,
} from "./application-appearance";
import { normalizeApplicationThemeId } from "./application-theme";
import {
  normalizeJapaneseLineBreakSegmentationMode,
  normalizeJapaneseWordSegmentationMode,
} from "./japanese-segmentation";

export type ApplicationCommandId =
  | "workspace.backup"
  | "workspace.backup_settings"
  | "workspace.sync"
  | "workspace.sync_settings"
  | "workspace.history"
  | "note.recovery"
  | "namespace.group"
  | "namespace.rename_group"
  | "utility.tree"
  | "note.new"
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
  | "workspace.new"
  | "workspace.switch"
  | "application.update"
  | "application.version"
  | "application.diagnostics"
  | "application.colorscheme"
  | "application.font"
  | "application.note_font_japanese"
  | "application.note_font_latin"
  | "application.note_font_monospace"
  | "application.note_line_height"
  | "application.note_block_gap"
  | "application.note_list_item_gap"
  | "application.note_section_title_gap_before"
  | "application.note_section_title_gap_after"
  | "application.note_section_title_size"
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
    id: "workspace.sync",
    name: "sync",
    aliases: [],
    description: "登録端末へ再接続して差分の同期を確認する",
    argument: "none",
  },
  {
    id: "workspace.sync_settings",
    name: "sync-settings",
    aliases: [],
    description: "端末間同期の状態を確認し端末を追加・解除する",
    argument: "none",
  },
  {
    id: "workspace.backup",
    name: "backup",
    aliases: [],
    description: "未保存の履歴を作成し追加保存先へ転送する",
    argument: "none",
  },
  {
    id: "workspace.backup_settings",
    name: "backup-settings",
    aliases: [],
    description:
      "バックアップの状態を確認し、保存先・保持数・資格情報を設定する",
    argument: "none",
  },
  {
    id: "workspace.history",
    name: "history",
    aliases: [],
    description: "現在のノートまたはWorkspaceの履歴を読み取り専用で参照する",
    argument: "none",
  },
  {
    id: "note.recovery",
    name: "recovery",
    aliases: [],
    description: "現在のノートの保護されたSection・Block・本文を復旧する",
    argument: "none",
  },
  {
    id: "namespace.group",
    name: "group",
    aliases: [],
    description: "選択Entryの子に整理用グループを作る",
    argument: "none",
  },
  {
    id: "namespace.rename_group",
    name: "rename-group",
    aliases: [],
    description: "Treeで選択したグループの名前を変更する",
    argument: "none",
  },
  {
    id: "utility.tree",
    name: "tree",
    aliases: [],
    description: "Treeを開く",
    argument: "none",
  },
  {
    id: "note.new",
    name: "new-note",
    aliases: [],
    description: "Treeに表示しない新しいノートを作り、現在のWindowで開く",
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
    id: "workspace.new",
    name: "new-workspace",
    aliases: [],
    description: "空のWorkspaceを作成するか別端末から受信する",
    argument: "none",
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
    name: "ui-font",
    aliases: ["font"],
    description: "アプリケーションUIのフォントを選択・変更する",
    argument: "optional",
  },
  {
    id: "application.note_font_japanese",
    name: "note-font-ja",
    aliases: [],
    description: "Noteの日本語フォントを選択・変更する",
    argument: "optional",
  },
  {
    id: "application.note_font_latin",
    name: "note-font-latin",
    aliases: [],
    description: "Noteの英数フォントを選択・変更する",
    argument: "optional",
  },
  {
    id: "application.note_font_monospace",
    name: "note-font-mono",
    aliases: [],
    description: "Noteの等幅フォントを選択・変更する",
    argument: "optional",
  },
  {
    id: "application.note_line_height",
    name: "note-line-height",
    aliases: [],
    description: "Note本文の行間倍率を表示・変更する",
    argument: "optional",
  },
  {
    id: "application.note_block_gap",
    name: "block-gap",
    aliases: [],
    description: "Note本文のブロック間隔を表示・変更する",
    argument: "optional",
  },
  {
    id: "application.note_list_item_gap",
    name: "list-item-gap",
    aliases: [],
    description: "Note本文のリスト項目間隔を表示・変更する",
    argument: "optional",
  },
  {
    id: "application.note_section_title_gap_before",
    name: "section-title-gap-before",
    aliases: [],
    description: "Section title前の間隔を表示・変更する",
    argument: "optional",
  },
  {
    id: "application.note_section_title_gap_after",
    name: "section-title-gap-after",
    aliases: [],
    description: "Section title後の間隔を表示・変更する",
    argument: "optional",
  },
  {
    id: "application.note_section_title_size",
    name: "section-title-size",
    aliases: [],
    description: "Section titleの相対サイズを表示・変更する",
    argument: "optional",
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
  | { readonly kind: "line"; readonly lineNumber: number }
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
  if (/^\d+$/u.test(source)) {
    const lineNumber = Number(source);
    return Number.isSafeInteger(lineNumber) && lineNumber > 0
      ? { kind: "line", lineNumber }
      : { kind: "error", message: "行番号は1以上の整数で指定してください" };
  }
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
  if (
    arguments_.length > 0 &&
    [
      "application.font",
      "application.note_font_japanese",
      "application.note_font_latin",
      "application.note_font_monospace",
    ].includes(command.id)
  ) {
    return {
      kind: "command",
      command,
      argument: source.slice(name.length).trim(),
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

export interface ApplicationCommandArgumentHelp {
  readonly syntax: string;
  readonly description: string;
}

const ARGUMENT_HELP: Partial<
  Record<ApplicationCommandId, ApplicationCommandArgumentHelp>
> = {
  "editor.image_width": {
    syntax: "[10..100%]",
    description:
      "現在の画像の表示幅を確認・変更します。変更時は10〜100の整数を指定し、末尾の%は省略できます。",
  },
  "application.colorscheme": {
    syntax: "[theme-name]",
    description:
      "Nightfoxカラーテーマを選択・変更します。変更時はテーマ名を指定します（例: duskfox）。",
  },
  "application.font": {
    syntax: "[font-family]",
    description:
      "アプリケーションUIのフォントを選択・変更します。変更時はCSS font-familyを指定し、空白を含む名前も使えます。",
  },
  "application.note_font_japanese": {
    syntax: "[font-family]",
    description:
      "Noteの日本語フォントを選択・変更します。変更時はCSS font-familyを指定します。",
  },
  "application.note_font_latin": {
    syntax: "[font-family]",
    description:
      "Noteの英数フォントを選択・変更します。変更時はCSS font-familyを指定します。",
  },
  "application.note_font_monospace": {
    syntax: "[font-family]",
    description:
      "Noteの等幅フォントを選択・変更します。変更時はCSS font-familyを指定します。",
  },
  "application.note_line_height": {
    syntax: "[1..2.5]",
    description:
      "Note本文の行間倍率を確認・変更します。変更時は1〜2.5の値を小数第2位まで指定します。",
  },
  "application.note_block_gap": {
    syntax: "[0..3]",
    description:
      "Note本文のブロック間隔を確認・変更します。変更時は0〜3emの値を小数第2位まで指定します。",
  },
  "application.note_list_item_gap": {
    syntax: "[0..3]",
    description:
      "Note本文のリスト項目間隔を確認・変更します。変更時は0〜3emの値を小数第2位まで指定します。",
  },
  "application.note_section_title_gap_before": {
    syntax: "[0..3]",
    description:
      "Section title前の間隔を確認・変更します。変更時は0〜3emの値を小数第2位まで指定します。",
  },
  "application.note_section_title_gap_after": {
    syntax: "[0..3]",
    description:
      "Section title後の間隔を確認・変更します。変更時は0〜3emの値を小数第2位まで指定します。",
  },
  "application.note_section_title_size": {
    syntax: "[0.8..3]",
    description:
      "Section titleの相対サイズを確認・変更します。変更時は0.8〜3の値を小数第2位まで指定します。",
  },
  "application.zoom": {
    syntax: "[50..200]",
    description:
      "現在のZoom倍率を確認・変更します。変更時は50〜200%の値を10刻みで指定します。",
  },
  "application.note_width": {
    syntax: "[320..4096|off]",
    description:
      "Noteの最大表示幅を確認・変更します。変更時は320〜4096pxを指定し、offで上限を解除できます。",
  },
  "application.line_number_min_width": {
    syntax: "[240..4096|off]",
    description:
      "行番号を表示するWindowの最小幅を確認・変更します。変更時は240〜4096pxを指定し、offで幅の条件を解除できます。",
  },
  "application.indent_width": {
    syntax: "[16..64]",
    description:
      "SectionとListに共通のインデント幅を確認・変更します。変更時は16〜64pxを指定します。",
  },
  "application.japanese_word_segmentation": {
    syntax: "[fine|budoux|unicode]",
    description:
      "日本語word操作の分割方式を確認・変更します。変更時はfine、budoux、unicodeのいずれかを指定します。",
  },
  "application.japanese_line_break_segmentation": {
    syntax: "[fine|budoux|native]",
    description:
      "日本語本文の表示改行方式を確認・変更します。変更時はfine、budoux、nativeのいずれかを指定します。",
  },
};

export function applicationCommandArgumentHelp(
  command: ApplicationCommandDefinition,
): ApplicationCommandArgumentHelp | null {
  return ARGUMENT_HELP[command.id] ?? null;
}

/** Checks whether a Picker input can execute without additional editing. */
export function applicationCommandArgumentIsComplete(
  command: ApplicationCommandDefinition,
  argument: string | null,
): boolean {
  if (command.argument === "none") return argument === null;
  if (argument === null) return false;
  const decimal = /^\d+(?:\.\d{1,2})?$/u.test(argument)
    ? Number(argument)
    : Number.NaN;
  const integer = /^\d+$/u.test(argument) ? Number(argument) : Number.NaN;
  switch (command.id) {
    case "editor.image_width": {
      const match = /^(\d+)%?$/u.exec(argument);
      const value = match ? Number(match[1]) : Number.NaN;
      return Number.isInteger(value) && value >= 10 && value <= 100;
    }
    case "application.colorscheme":
      return normalizeApplicationThemeId(argument) !== null;
    case "application.font":
    case "application.note_font_japanese":
    case "application.note_font_latin":
    case "application.note_font_monospace":
      return normalizeApplicationFontFamily(argument) !== null;
    case "application.note_line_height":
      return normalizeNoteLineHeight(decimal) !== null;
    case "application.note_block_gap":
    case "application.note_list_item_gap":
    case "application.note_section_title_gap_before":
    case "application.note_section_title_gap_after":
      return normalizeNoteGapEm(decimal) !== null;
    case "application.note_section_title_size":
      return normalizeNoteSectionTitleSizeEm(decimal) !== null;
    case "application.zoom":
      return normalizeApplicationZoomPercent(integer) !== null;
    case "application.note_width":
      return (
        normalizeApplicationNoteMaxWidthPx(
          argument.toLocaleLowerCase() === "off" ? 0 : integer,
        ) !== null
      );
    case "application.line_number_min_width":
      return (
        normalizeApplicationLineNumberMinWidthPx(
          argument.toLocaleLowerCase() === "off" ? 0 : integer,
        ) !== null
      );
    case "application.indent_width":
      return normalizeApplicationIndentWidthPx(integer) !== null;
    case "application.japanese_word_segmentation":
      return normalizeJapaneseWordSegmentationMode(argument) !== null;
    case "application.japanese_line_break_segmentation":
      return normalizeJapaneseLineBreakSegmentationMode(argument) !== null;
    default:
      return false;
  }
}
