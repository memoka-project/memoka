import { APPLICATION_COMMANDS } from "./application-command";
import type {
  ListItemBlock,
  NoteBlock,
  TableCellBlock,
  TableRowBlock,
} from "./documents";
import { createUuidV7 } from "./ids";
import type { SectionSnapshot } from "./section-model";

export const MEMOKA_HELP_TITLE = "Memoka help";

/**
 * Managed Help uses the same recursive Section model as user content. Stable
 * semantic IDs make repeated :help synchronization deterministic.
 */
export function createMemokaHelpSectionSnapshot(
  noteId: string,
): SectionSnapshot {
  const id = (key: string): string => stableHelpId(noteId, key);
  const paragraph = (key: string, text: string): NoteBlock => ({
    type: "paragraph",
    blockId: id(`paragraph:${key}`),
    content: [{ type: "text", text }],
  });
  const listItem = (
    key: string,
    text: string,
    children: NoteBlock[] = [],
  ): ListItemBlock => ({
    type: "listItem",
    blockId: id(`list-item:${key}`),
    children: [paragraph(`list-item:${key}`, text), ...children],
  });
  const bulletList = (key: string, items: ListItemBlock[]): NoteBlock => ({
    type: "bulletList",
    blockId: id(`bullet-list:${key}`),
    children: items,
  });
  const tableCell = (
    key: string,
    text: string,
    header = false,
  ): TableCellBlock => ({
    type: header ? "tableHeader" : "tableCell",
    blockId: id(`table-cell:${key}`),
    children: [paragraph(`table-cell:${key}`, text)],
  });
  const tableRow = (
    key: string,
    values: readonly string[],
    header = false,
  ): TableRowBlock => ({
    type: "tableRow",
    blockId: id(`table-row:${key}`),
    children: values.map((value, index) =>
      tableCell(`${key}:${index}`, value, header),
    ),
  });
  const table = (
    key: string,
    headings: readonly string[],
    rows: readonly (readonly string[])[],
  ): NoteBlock => ({
    type: "table",
    blockId: id(`table:${key}`),
    children: [
      tableRow(`${key}:header`, headings, true),
      ...rows.map((row, index) => tableRow(`${key}:${index}`, row)),
    ],
  });
  const section = (
    key: string,
    title: string,
    body: readonly NoteBlock[],
    children: readonly SectionSnapshot[] = [],
  ): SectionSnapshot => ({
    sectionId: id(`section:${key}`),
    title,
    tags: [],
    body: body.map(blockToSnapshotJson),
    children,
  });

  return {
    sectionId: noteId,
    title: MEMOKA_HELP_TITLE,
    tags: [],
    body: [
      blockToSnapshotJson(
        paragraph(
          "intro",
          "Memokaは、Markdown記号を意識せずに、Vimの操作感で素早く書くローカルファーストのメモ帳です。編集内容は構造化されたNoteDocへ自動保存されます。",
        ),
      ),
    ],
    children: [
      section("first-steps", "最初に覚える", [
        bulletList("first-steps", [
          listItem(
            "mode",
            "Normal modeでは移動とCommand、Insert modeでは本文入力を行います。",
            [
              bulletList("mode-details", [
                listItem(
                  "mode-insert",
                  "i / a / I / A / o / O: Insert modeへ入る",
                ),
                listItem(
                  "mode-normal",
                  "Esc: Insert・VisualからNormal modeへ戻る",
                ),
                listItem(
                  "mode-visual",
                  "v: 文字選択、V: 論理行・構造単位の選択",
                ),
              ]),
            ],
          ),
          listItem(
            "ime",
            "日本語IMEの変換中はEditorがcompositionを優先します。Escは変換を終了してからNormal modeへ戻ります。",
          ),
          listItem(
            "save",
            "保存操作は不要です。確定した編集はCore transactionを通って自動保存されます。",
          ),
        ]),
      ]),
      section("movement-editing", "移動と編集", [
        table(
          "movement-editing",
          ["目的", "キー", "動作"],
          [
            ["基本移動", "[count]h/j/k/l", "文字・論理行を移動"],
            ["単語移動", "w / b / e", "次・前・末尾の単語境界へ移動"],
            ["行内移動", "0 / $", "論理行の先頭・末尾へ移動"],
            ["文書移動", "gg / G", "表示中のSection subtreeの先頭・末尾へ移動"],
            [
              "ノート内検索",
              "/、[count]n / N",
              "現在のFocused Section内を検索し、次・前の一致へ移動",
            ],
            ["削除", "x / dd / D", "文字・論理行・行末までを削除"],
            ["変更", "c + motion / cc / C", "範囲を置換してInsert modeへ移動"],
            ["Yank", "y + motion / yy", "文字または構造をClipboardへコピー"],
            [
              "Paste",
              "p / P",
              "カーソルの後・前へregister、または外部でcopyしたfileを貼り付け",
            ],
            ["履歴", "u / Ctrl-r", "NoteDoc共有履歴をUndo / Redo"],
            ["選択", "v / V", "文字・論理行／Section構造を選択"],
            [
              "文字装飾",
              "vで選択 → m",
              "共通検索ペインから斜体・太字・打ち消し・コード・外部リンク・全解除を適用",
            ],
            [
              "外部リンク・添付を開く",
              "gx",
              "caret下の安全な外部リンクまたは添付をOSへ渡す",
            ],
            [
              "Section focus",
              "zf / zF",
              "caret方向へ1階層絞る／現在Focusから親へ1階層戻る",
            ],
            [
              "Section階層",
              ">> / <<、Visual Lineの > / <",
              "Sectionタイトルを1段降格／昇格",
            ],
          ],
        ),
      ]),
      section("windows", "Window・Sidebar・Tab", [
        table(
          "windows",
          ["キー", "動作"],
          [
            ["Ctrl-w h/j/k/l", "WindowまたはSidebar間でフォーカス移動"],
            ["Ctrl-w s / v", "現在Windowを上下・左右に分割"],
            ["Ctrl-w c", "現在WindowまたはSidebarを閉じる"],
            ["Ctrl-w o", "現在Windowだけを残し、左右Sidebarを閉じる"],
            [",t / ,o", "Tree・Outlineをトグル"],
            [",f / ,g / ,b", "Sectionタイトル・本文・読み込み済みBufferを検索"],
            ["gt / gT、tn / tp", "次・前のTabPageへ循環移動"],
            ["tc / td", "空のTabPageを作成／現在TabPageを閉じる"],
          ],
        ),
      ]),
      section("notes", "ノートとSection", [
        bulletList("notes", [
          listItem(
            "notes-sidebar",
            "Treeはノートを親子関係で整理します。[count]j/k・gg/Gで選択、h/lで折り畳みまたは親子移動、Enterで現在Windowへ開きます。",
          ),
          listItem(
            "tree-edit",
            "Treeではaで次の兄弟、cで子、Aでtop-levelノートを作ります。J/Kで兄弟順、H/Lで階層を変更し、Dで選択ノートとliveな子孫をTrashへ移します。新規タイトルはEditor内で入力します。",
          ),
          listItem(
            "section-create",
            "直接本文の段落先頭で「# 」を入力すると、その段落以降を本文に持つ子Sectionを作成します。",
          ),
          listItem(
            "block-type-picker",
            "直接本文の空ParagraphでInsert modeから「/」を入力すると、共通検索ペインでParagraph、Bullet List、Numbered List、Code Block、Source Block、Table、Image Block stub、Attachment Fileを選べます。Esc / Ctrl-cで取り消すと「/」は本文に残ります。確定後のuは最初に「/」へ戻り、もう一度uを押すと「/」も戻します。",
          ),
          listItem(
            "attachments",
            "Attachment Fileまたは:attachでファイルを追加できます。PNG・JPEG・WebP・GIFは画像、それ以外は1つのAttachment Blockとして扱います。file paste / dropにも対応し、clickは選択だけ、gxで安全な形式だけをOS既定アプリへ渡します。",
          ),
          listItem(
            "section-depth",
            "Sectionタイトル上でNormalの>> / <<、InsertのCtrl-t / Ctrl-d、Visual Lineの> / <を使うと、表示順を変えずに階層を1段変更します。",
          ),
          listItem(
            "links",
            "Insert modeで[[を入力するとInternal Section Link候補が開き、Normalのgfで対象SectionへFocusします。外部リンクはVisual-charで文字を選択してmから設定し、clickでは開かずNormalのgxで開きます。",
          ),
          listItem(
            "inline-format",
            "文字装飾はParagraph、ListItem、Table Cell内の文字へ適用できます。同じ装飾の再適用はtoggleではなく変更なしとなり、「全装飾を解除」で対応markをまとめて外します。確定は1 Undo単位、Esc / Ctrl-cはVisual選択を保って取消します。",
          ),
          listItem(
            "search",
            "/で現在のFocused Section subtree内を部分一致検索し、n / Nで次・前の一致へ移動します。Root表示中はNoteDoc全体が対象です。,fでSectionタイトルとパンくず、,gで直接本文を検索します。Workspace検索の空白区切りはAND条件です。",
          ),
          listItem(
            "outline",
            "Outlineはactive Windowで現在表示しているFocused Section subtreeだけを示し、Root表示中はNoteDoc全体を示します。Enterで選択Sectionのタイトル先頭へ移動し、Ctrl-o / Ctrl-iでJump Listを移動します。caretがあるSectionの祖先はWindow下端のステータスラインに表示され、breadcrumbのclickでもSectionへFocusせずタイトル先頭へ移動します。zfはcaret位置を保って1階層深く絞り、zFはcaretの深さに関係なく現在Focusから親へ1階層戻ります。",
          ),
          listItem(
            "trash",
            ":trashで削除済みノート検索を開き、rで復元します。Enter / Tabは無効で、Esc / Ctrl-cで閉じます。",
          ),
          listItem(
            "key-config",
            "Leader、共通cursor移動、Tree操作、Visual-charの文字装飾キーはapplication config directoryのconfig.tomlで変更できます。[shutdown]のwait_for_mirror = falseを指定すると、終了時は正本だけを保存し、mirror生成を次回起動後へ回します。既定値はtrueです。不正な設定は全体を無効にして既定値へ戻します。",
          ),
          listItem(
            "portable-data",
            "初回起動時にWorkspaceデータ領域を選びます。内部SSOTはその中の.memoka、タイトル由来Markdownと復旧用mirrorは直下へ10秒idle後・既定では終了前・切替前に自動出力されます。起動時にrevisionが一致すれば再生成せず、通常の本文編集は変更Noteだけを差分更新します。タイトル由来pathの変更やmirror破損時はリンク整合性のため全体を再構築します。終了時に待つ間は生成phaseと書込率を表示します。別領域へ移るときは:switch-workspaceを使います。mirrorは外部編集を読み戻しません。Memokaを二重起動すると新しいプロセスはWorkspaceを開かず終了し、既存Windowを前面へ戻します。",
          ),
        ]),
      ]),
      section("command-line", "Command-line", [
        {
          type: "codeBlock",
          blockId: id("code-block:commands"),
          language: "text",
          text: APPLICATION_COMMANDS.map(
            ({ name, aliases, description }) =>
              `:${name}${aliases.length > 0 ? ` (${aliases.map((alias) => `:${alias}`).join(", ")})` : ""} — ${description}`,
          ).join("\n"),
        },
      ]),
      section("managed-help", "このHelpについて", [
        paragraph(
          "managed-help",
          "このノートはMemokaが管理します。:helpを再実行すると最新のSection構造と操作説明へ同期されます。",
        ),
      ]),
    ],
  };
}

function blockToSnapshotJson(block: NoteBlock): unknown {
  const attrs: Record<string, unknown> = { blockId: block.blockId };
  let content: unknown[] = [];
  switch (block.type) {
    case "paragraph":
      content = block.content.map((inline) =>
        inline.type === "text"
          ? { type: "text", text: inline.text }
          : {
              type: "internalSectionLink",
              attrs: { targetSectionId: inline.targetSectionId },
              content: [{ type: "text", text: inline.text }],
            },
      );
      break;
    case "bulletList":
    case "listItem":
    case "blockquote":
    case "table":
    case "tableRow":
      content = block.children.map(blockToSnapshotJson);
      break;
    case "horizontalRule":
      break;
    case "orderedList":
      attrs.start = block.start ?? 1;
      content = block.children.map(blockToSnapshotJson);
      break;
    case "tableCell":
    case "tableHeader":
      if (block.alignment) attrs.align = block.alignment;
      content = block.children.map(blockToSnapshotJson);
      break;
    case "codeBlock":
      if (block.language) attrs.language = block.language;
      content = [{ type: "text", text: block.text }];
      break;
    case "sourceBlock":
      attrs.sourceFormat = block.sourceFormat;
      content = [{ type: "text", text: block.text }];
      break;
    case "image":
      attrs.attachmentId = block.attachmentId;
      attrs.alt = block.altText;
      attrs.alignment = block.alignment ?? "center";
      if (block.width !== undefined) attrs.width = block.width;
      break;
    case "attachment":
      attrs.attachmentId = block.attachmentId;
      attrs.label = block.label;
      break;
  }
  return { type: block.type, attrs, content };
}

function stableHelpId(noteId: string, semanticKey: string): string {
  const compact = noteId.replaceAll("-", "");
  const timestamp = Number.parseInt(compact.slice(0, 12), 16);
  let state = hashString(`${noteId}\u0000${semanticKey}`) || 0x9e3779b9;
  return createUuidV7(timestamp, (target) => {
    for (let index = 0; index < target.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      target[index] = state >>> ((index % 4) * 8);
    }
    return target;
  });
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
