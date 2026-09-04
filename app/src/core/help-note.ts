import { APPLICATION_COMMANDS } from "./application-command";
import { LEADER_SHORTCUT_CATALOG } from "./leader-shortcuts";
import { createUuidV7 } from "./ids";
import type { SectionSnapshot } from "./section-model";

export const MEMOKA_HELP_TITLE = "Memoka help";

type HelpMark =
  | { readonly type: "bold" | "italic" | "strike" | "code" }
  | { readonly type: "link"; readonly attrs: { readonly href: string } };

type HelpInline =
  | {
      readonly type: "text";
      readonly text: string;
      readonly marks?: readonly HelpMark[];
    }
  | {
      readonly type: "internalSectionLink";
      readonly attrs: { readonly targetSectionId: string };
      readonly content: readonly [
        { readonly type: "text"; readonly text: string },
      ];
    };

type HelpRichText = string | readonly HelpInline[];
type HelpNode = Readonly<Record<string, unknown>>;

/**
 * Managed Help uses the same recursive Section model as user content. Stable
 * semantic IDs make repeated :help synchronization deterministic.
 */
export function createMemokaHelpSectionSnapshot(
  noteId: string,
): SectionSnapshot {
  const id = (key: string): string => stableHelpId(noteId, key);
  const text = (value: string, ...marks: readonly HelpMark[]): HelpInline => ({
    type: "text",
    text: value,
    ...(marks.length > 0 ? { marks } : {}),
  });
  const rich = (
    ...parts: readonly (string | HelpInline | readonly HelpInline[])[]
  ): readonly HelpInline[] =>
    parts.flatMap((part) =>
      typeof part === "string" ? (part ? [text(part)] : []) : part,
    );
  const bold = (value: string): HelpInline => text(value, { type: "bold" });
  const italic = (value: string): HelpInline => text(value, { type: "italic" });
  const code = (value: string): HelpInline => text(value, { type: "code" });
  const externalLink = (label: string, href: string): HelpInline =>
    text(label, { type: "link", attrs: { href } });
  const helpLink = (key: string, label: string): HelpInline => ({
    type: "internalSectionLink",
    attrs: { targetSectionId: id(`section:${key}`) },
    content: [{ type: "text", text: label }],
  });
  const inlineContent = (value: HelpRichText): readonly HelpInline[] =>
    typeof value === "string" ? (value ? [text(value)] : []) : value;
  const paragraph = (key: string, value: HelpRichText): HelpNode => ({
    type: "paragraph",
    attrs: { blockId: id(`paragraph:${key}`) },
    content: inlineContent(value),
  });
  const listItem = (
    key: string,
    value: HelpRichText,
    children: readonly HelpNode[] = [],
  ): HelpNode => ({
    type: "listItem",
    attrs: { blockId: id(`list-item:${key}`) },
    content: [paragraph(`list-item:${key}`, value), ...children],
  });
  const bulletList = (key: string, items: readonly HelpNode[]): HelpNode => ({
    type: "bulletList",
    attrs: { blockId: id(`bullet-list:${key}`) },
    content: items,
  });
  const tableCell = (
    key: string,
    value: HelpRichText,
    header = false,
  ): HelpNode => ({
    type: header ? "tableHeader" : "tableCell",
    attrs: { blockId: id(`table-cell:${key}`) },
    content: [paragraph(`table-cell:${key}`, value)],
  });
  const tableRow = (
    key: string,
    values: readonly HelpRichText[],
    header = false,
  ): HelpNode => ({
    type: "tableRow",
    attrs: { blockId: id(`table-row:${key}`) },
    content: values.map((value, index) =>
      tableCell(`${key}:${index}`, value, header),
    ),
  });
  const table = (
    key: string,
    headings: readonly HelpRichText[],
    rows: readonly (readonly HelpRichText[])[],
  ): HelpNode => ({
    type: "table",
    attrs: { blockId: id(`table:${key}`) },
    content: [
      tableRow(`${key}:header`, headings, true),
      ...rows.map((row, index) => tableRow(`${key}:${index}`, row)),
    ],
  });
  const section = (
    key: string,
    title: string,
    body: readonly HelpNode[],
    children: readonly SectionSnapshot[] = [],
  ): SectionSnapshot => ({
    sectionId: id(`section:${key}`),
    title,
    tags: [],
    body,
    children,
  });

  return {
    sectionId: noteId,
    title: MEMOKA_HELP_TITLE,
    tags: [],
    body: [
      paragraph(
        "intro",
        rich(
          bold("Memoka"),
          "は、Markdown記号を意識せずに、Vimの操作感で素早く書く",
          italic("ローカルファースト"),
          "のメモ帳です。編集内容は構造化された",
          code("NoteDoc"),
          "へ自動保存されます。",
        ),
      ),
    ],
    children: [
      section("contents", "目次", [
        paragraph(
          "contents-intro",
          rich(
            "このHelpは現在の製品操作をまとめた",
            bold("唯一の利用者向けマニュアル"),
            "です。次のInternal Linkは",
            code("gf"),
            "で開けます。",
          ),
        ),
        bulletList("contents", [
          listItem(
            "contents-first",
            rich(helpLink("first-steps", "最初に覚える")),
          ),
          listItem(
            "contents-insert",
            rich(helpLink("insert-mode", "Insert mode")),
          ),
          listItem(
            "contents-movement",
            rich(helpLink("movement-editing", "移動と編集")),
          ),
          listItem(
            "contents-table",
            rich(helpLink("table-editing", "Table編集")),
          ),
          listItem(
            "contents-notes",
            rich(helpLink("notes", "ノートとSection")),
          ),
          listItem(
            "contents-windows",
            rich(helpLink("windows", "Window・Sidebar・Tab")),
          ),
          listItem(
            "contents-leader",
            rich(helpLink("leader-shortcuts", "Leader shortcuts")),
          ),
          listItem(
            "contents-command",
            rich(helpLink("command-line", "Command-line")),
          ),
        ]),
      ]),
      section("first-steps", "最初に覚える", [
        bulletList("first-steps", [
          listItem(
            "mode",
            rich(
              code("Normal mode"),
              "では移動とCommand、",
              code("Insert mode"),
              "では本文入力を行います。",
            ),
            [
              bulletList("mode-details", [
                listItem(
                  "mode-insert",
                  rich(code("i / a / I / A / o / O"), ": Insert modeへ入る"),
                ),
                listItem(
                  "mode-normal",
                  rich(code("Esc / Ctrl-c"), ": InsertからNormal modeへ戻る"),
                ),
                listItem(
                  "mode-visual",
                  rich(
                    code("v"),
                    ": 文字選択、",
                    code("V"),
                    ": 論理行・構造単位の選択、Table内の",
                    code("Ctrl-v"),
                    ": 矩形Cell選択",
                  ),
                ),
                listItem(
                  "mode-visual-reselect",
                  rich(
                    code("gv"),
                    ": 直前のVisual選択を復元。Visual中は現在と直前の選択を交換",
                  ),
                ),
              ]),
            ],
          ),
          listItem(
            "ime",
            rich(
              "日本語IMEの変換中はEditorが",
              code("composition"),
              "を優先します。",
              code("Esc / Ctrl-c"),
              "はまず変換を終了し、その後の入力でNormal modeへ戻ります。",
            ),
          ),
          listItem(
            "save",
            rich(
              bold("保存操作は不要です。"),
              "確定した編集はCore transactionを通って自動保存されます。",
            ),
          ),
        ]),
      ]),
      section("insert-mode", "Insert mode", [
        paragraph(
          "insert-intro",
          rich(
            "通常の文字入力と矢印移動はEditorへ渡します。次のCtrl操作はVim互換の入力補助です。",
            italic("IME変換中はIME側の操作を優先します。"),
          ),
        ),
        table(
          "insert-keys",
          ["キー", "動作", "範囲・補足"],
          [
            [
              rich(code("Esc / Ctrl-c")),
              "Normal modeへ戻る",
              "Insert caretの直前の文字にNormal caretを置く",
            ],
            [
              rich(code("Ctrl-h")),
              "Backspace",
              "選択範囲、1文字、またはblock境界を通常のBackspaceと同じ規則で削除",
            ],
            [
              rich(code("Ctrl-j / Ctrl-m")),
              "改行",
              "通常のEnterと同じ。現在blockに応じてParagraphやListItemを分割",
            ],
            [
              rich(code("Ctrl-u")),
              "行頭からcaret直前まで削除",
              "表示上の折返しではなく、Paragraph先頭またはShift-Enterによる明示改行までを対象",
            ],
            [
              rich(code("Ctrl-w")),
              "直前の単語を削除",
              "空白を後方へ読み飛ばしてから、直前の単語classまたは連続する記号を削除",
            ],
            [
              rich(code("Ctrl-t")),
              "Sectionを1段深くする",
              "SectionタイトルではNormalの >>、直接本文Paragraphでは子Section化",
            ],
            [
              rich(code("Ctrl-d")),
              "Sectionを1段浅くする",
              "SectionタイトルではNormalの <<、直接本文Paragraphでは兄弟Section化",
            ],
            [
              rich(code("Ctrl-Enter")),
              "構造blockから脱出",
              "List、Table、Code Block、Blockquoteの直後に新しいParagraphを作成",
            ],
            [
              rich(code("Tab / Shift-Tab")),
              "文脈依存の移動・階層変更",
              "ListItemの階層変更、Tableの次・前Cellへの移動など",
            ],
          ],
        ),
        paragraph(
          "insert-word-definition",
          rich(
            bold("単語の定義: "),
            code("Ctrl-w"),
            "とNormalの",
            code("w / b / e"),
            "は同じ分類を使います。漢字、ひらがな、カタカナ、英数字とunderscoreをそれぞれ別の連続単位として扱います。濁点などの結合文字と長音・中点などの共有仮名記号は隣の文字へ属し、空白・句読点・記号・emojiは単語外です。",
          ),
        ),
        paragraph(
          "insert-section-conversion",
          rich(
            bold("直接本文ParagraphのSection化: "),
            "Section直下のParagraph上では、Insert modeの",
            code("Ctrl-t"),
            "またはNormal modeの",
            code(">>"),
            "を押すと、そのParagraphをタイトルにした最初の子Sectionを作ります。",
            "Insertの",
            code("Ctrl-d"),
            "またはNormalの",
            code("<<"),
            "では現在Section直後の兄弟Sectionを作ります。Paragraphより後ろの本文も新Sectionへ移り、兄弟化では表示順を守るため現在Sectionの子Sectionも新Sectionの配下へ移ります。タイトルは表示文字だけを使い、装飾とLinkを外し、",
            code("Shift-Enter"),
            "の改行を空白へ変換します。Normal操作後はNormal modeを維持し、",
            code("u"),
            "で元に戻せます。",
          ),
        ),
        paragraph(
          "insert-section-reverse",
          rich(
            bold("一時的な逆変換: "),
            "Insert modeのCtrl-t / Ctrl-dによる変換直後は反対のキーで元のParagraph、装飾、Link、caret位置を完全に戻せます。Normalの>> / <<にはこの逆変換を適用せず、uで戻します。Insertでの逆変換は移動だけなら有効ですが、",
            italic(
              "本文編集、別の構造操作、Undo、またはノートの再読込を行うと逆変換情報は破棄されます。",
            ),
          ),
        ),
      ]),
      section("leader-shortcuts", "Leader shortcuts", [
        paragraph(
          "leader-summary",
          "既定Leaderは「,」です。config.tomlで物理Leaderキーだけを変更でき、後続のカテゴリ文字はHelp・設定・将来のPluginで共通になるよう固定されています。未実装の予約キーも別の操作として再解釈されません。",
        ),
        table(
          "leader-shortcuts",
          ["キー", "カテゴリ", "状態"],
          LEADER_SHORTCUT_CATALOG.map((shortcut) => [
            `<Leader>${shortcut.key}`,
            shortcut.label,
            shortcut.status === "active" ? "利用可能" : "予約済み（未実装）",
          ]),
        ),
      ]),
      section("movement-editing", "移動と編集", [
        table(
          "movement-editing",
          ["目的", "キー", "動作"],
          [
            [
              "基本移動",
              rich(code("[count]h/j/k/l")),
              "文字・論理行を移動。h/lの行端越えはwhichwrapで設定",
            ],
            [
              "表示行移動",
              rich(code("gj / gk")),
              "同じ論理行内を含む、画面上の折返し行を上下移動",
            ],
            [
              "単語移動",
              rich(code("w / b / e")),
              "次・前・末尾の単語境界へ移動。日本語の分類はInsert mode章を参照",
            ],
            ["行内移動", rich(code("0 / $")), "論理行の先頭・末尾へ移動"],
            [
              "文書移動",
              rich(code("gg / G")),
              "表示中のSection subtreeの先頭・末尾へ移動",
            ],
            [
              "画面移動",
              rich(code("Ctrl-f / Ctrl-b")),
              "1画面ぶん下・上へ移動",
            ],
            [
              "半画面移動",
              rich(code("Ctrl-d / Ctrl-u")),
              "半画面ぶん下・上へ移動",
            ],
            [
              "ノート内検索",
              rich(code("/、[count]n / N")),
              "現在のFocused Section内を検索し、次・前の一致へ移動",
            ],
            [
              "削除",
              rich(code("x / d{motion} / dd / D")),
              "文字・motion範囲・論理行・行末までを削除",
            ],
            [
              "変更",
              rich(code("c{motion} / cc / C / S")),
              "範囲、論理行内容、または行末までを置換してInsert modeへ移動",
            ],
            [
              "文字置換",
              rich(code("[count]r{char} / R")),
              "文字を置換／Replace modeへ移動",
            ],
            [
              "行連結",
              rich(code("J / gJ")),
              "空白を調整して連結／空白を一切調整せず連結",
            ],
            [
              "Yank",
              rich(code("y{motion} / yy")),
              "文字または論理行・構造をClipboardへコピー",
            ],
            [
              "Paste",
              rich(code("p / P")),
              "カーソルの後・前へregister、または外部でcopyしたfileを貼り付け",
            ],
            [
              "履歴",
              rich(code("u / Ctrl-r / .")),
              "NoteDoc共有履歴をUndo / Redo／直前の対応編集をrepeat",
            ],
            [
              "Text object",
              rich(code("iw / aw / ip / ap")),
              "operatorの対象を内側・周囲のwordまたはParagraphにする",
            ],
            [
              "選択",
              rich(code("v / V / Ctrl-v / gv")),
              "文字・論理行／Section構造・Table矩形を選択し、直前のVisual選択を復元",
            ],
            [
              "文字装飾",
              rich(code("v"), "で選択 → ", code("m")),
              "共通検索ペインから斜体・太字・打ち消し・コード・外部リンク・全解除を適用",
            ],
            [
              "外部リンク・添付を開く",
              rich(code("gx")),
              "caret下の安全な外部リンクまたは添付をOSへ渡す",
            ],
            [
              "Section focus",
              rich(code("zf / zF")),
              "caret方向へ1階層絞る／現在Focusから親へ1階層戻る",
            ],
            [
              "Section階層",
              rich(code(">> / <<"), "、Visual Lineの ", code("> / <")),
              "Sectionタイトルを1段降格／昇格。直接本文ParagraphではSectionへ変換",
            ],
          ],
        ),
        paragraph(
          "movement-count",
          rich(
            bold("Count: "),
            "数値を操作の前に置くと移動や編集を繰り返します（例: ",
            code("3j"),
            "、",
            code("2dw"),
            "、",
            code("4x"),
            "）。operator前後のCountは乗算し、上限は",
            code("9999"),
            "です。",
          ),
        ),
        paragraph(
          "movement-logical-line",
          rich(
            bold("論理行: "),
            "ParagraphとSectionタイトルではblock先頭、および",
            code("Shift-Enter"),
            "で明示した改行を境界にします。Window幅による自動折返しは論理行を増やしません。ListItem、Code Block、Table Cellなどは各構造に対応する境界を使います。",
          ),
        ),
      ]),
      section("table-editing", "Table編集", [
        table(
          "table-editing",
          ["Mode", "キー", "動作"],
          [
            [
              "Normal",
              "h / l、j / k",
              "左右は論理行内を行優先順でCellをまたぎ、whichwrap有効時は行端から前後論理行へ移動／上下は同じ列の前後行へ移動",
            ],
            [
              "Normal",
              "w / b / e",
              "同じ行のword境界を移動。空Cellも1つの停止位置",
            ],
            [
              "Normal",
              "Tab / Shift-Tab",
              "行優先順で次／前のCellへ移動。Table端では停止",
            ],
            [
              "Insert",
              "Enter / Shift-Enter",
              "Cell内Paragraphを分割／Hard Breakを入力",
            ],
            [
              "Insert",
              "Tab / Shift-Tab",
              "次／前のCellへ移動。最終CellのTabは本文行を追加",
            ],
            ["Insert", "Ctrl-Enter", "Table直後に新しいParagraphを作って脱出"],
            [
              "Visual Block",
              "Ctrl-v → h/j/k/l",
              "結合セルのないTableで矩形Cell範囲を選択",
            ],
            [
              "Visual Block",
              "y / d / c / p / P",
              "矩形をcopy／内容clear／現在Cellから置換。行・列構造は維持",
            ],
            [
              "Normal / Visual Line / Visual Block",
              "<Leader>a（既定 ,a）",
              "選択数ぶんの行・列追加、削除／移動、列揃え、Table削除を検索",
            ],
          ],
        ),
        paragraph(
          "table-clipboard",
          "Tableの矩形yankはMemoka内部構造、HTML、GFM Markdown、TSVを同時にClipboardへ出力します。Table内のp/Pはどちらも現在Cellを左上として貼り付けます。Table外でp/Pすると、headerを含む矩形はそのまま、本文行だけの矩形は空headerを補って新しいGFM互換Tableを作ります。行・列追加は.で選択数ごと再実行でき、先頭行は常にheaderです。",
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
            ["t1〜t9 / t0", "1〜10番目のTabPageへ直接移動"],
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
            "直接本文の空ParagraphでInsert modeから「/」を入力すると、共通検索ペインでParagraph、Bullet List、Numbered List、Code Block、Source Block、Table、Image Block stub、Attachment Fileを選べます。Tableは続く10×10グリッドでh/j/k/lまたは矢印を使って行列数を選び、Enterで作成します。Esc / Ctrl-cで取り消すと「/」は本文に残ります。確定後のuは最初に「/」へ戻り、もう一度uを押すと「/」も戻します。",
          ),
          listItem(
            "attachments",
            "Attachment Fileまたは:attachでファイルを追加できます。PNG・JPEG・WebP・GIFは画像、それ以外は1つのAttachment Blockとして扱います。file paste / dropにも対応し、clickは選択だけ、gxで安全な形式だけをOS既定アプリへ渡します。",
          ),
          listItem(
            "section-depth",
            "Sectionタイトル上でNormalの>> / <<、InsertのCtrl-t / Ctrl-d、Visual Lineの> / <を使うと、表示順を変えずに階層を1段変更します。直接本文Paragraph上のNormal >> / <<とInsert Ctrl-t / Ctrl-dは、そのParagraphを子／兄弟Sectionへ変換します。",
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
            "visual-reselect",
            rich(
              code("gv"),
              "は同じWindow・同じNoteで直前に使ったVisual Char、Visual Line、Visual Blockの範囲と向きを復元します。Visual中に実行すると現在の範囲と交換され、続けて",
              code("gv"),
              "を押して往復できます。編集で残った位置には追従しますが、削除済み、現在のFocused Section外、互換性のないTableになった範囲は復元せず通知します。履歴はアプリ終了時またはWindowを閉じた時に破棄され、Undoや",
              code("."),
              "の対象にはなりません。",
            ),
          ),
          listItem(
            "search",
            "/または,sで現在のFocused Section subtree内を部分一致検索し、n / Nで次・前の一致へ移動します。Root表示中はNoteDoc全体が対象です。,fでSectionタイトルとパンくず、,gで直接本文を検索します。Workspace検索の空白区切りはAND条件です。",
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
            "物理Leader、共通cursor移動、Tree操作、Visual-charの文字装飾キー、Tableの移動・Visual Block開始キーはapplication config directoryのconfig.tomlで変更できます。Leader後のカテゴリ文字とContext ActionsのLeader aは固定です。[vim]のwhichwrapはNormal／Visual Charのh/lが論理行端を越えるかを全block共通で制御し、既定値はtrueです。[shutdown]のwait_for_mirror = falseを指定すると、終了時は正本だけを保存し、mirror生成を次回起動後へ回します。既定値はtrueです。ノートの最大表示幅はnote_max_width_pxで指定し、0で上限を解除できます。不正な設定は全体を無効にして既定値へ戻します。",
          ),
          listItem(
            "color-theme",
            "カラーテーマは:colorscheme（:colo）でNightfox、Dayfox、Dawnfox、Duskfox、Nordfox、Terafox、Carbonfoxからライブプレビューして選べます。Enterでapplication config directoryのconfig.tomlへ保存し、Esc / Ctrl-cで開始時の配色へ戻します。:colorscheme duskfoxのような直接指定もできます。既定はNightfoxで、テーマはWorkspaceではなくアプリケーション全体の設定です。",
          ),
          listItem(
            "appearance",
            "フォントは:fontの共通検索ペインでプリセットまたは任意のCSS font-familyをライブプレビューして選択します。通常UIと本文へ適用し、コード、行番号、Command-line、デバッグ情報は等幅のままです。Ctrl+= / Ctrl++で10%拡大、Ctrl+-で10%縮小、Ctrl+0で100%へ戻せます。:zoomは現在値、:zoom 120は指定値を適用します。Zoomは50〜200%の10%刻みです。ノートキャンバスは既定で最大1000 CSS pxとし、広いWindow内で中央寄せにします。:note-widthで現在値を表示し、:note-width 1200で変更、:note-width offで上限を解除できます。フォント、Zoom、ノート幅はconfig.tomlへ保存され、Workspaceを切り替えても共通です。",
          ),
          listItem(
            "portable-data",
            "初回起動時にWorkspaceデータ領域を選びます。内部SSOTはその中の.memoka、タイトル由来Markdownと復旧用mirrorは直下へ10秒idle後・既定では終了前・切替前に自動出力されます。起動時にrevisionが一致すれば再生成せず、通常の本文編集は変更Noteだけを差分更新します。タイトル由来pathの変更やmirror破損時はリンク整合性のため全体を再構築します。終了時に待つ間は生成phaseと書込率を表示します。別領域へ移るときは:switch-workspaceを使います。mirrorは外部編集を読み戻しません。Memokaを二重起動すると新しいプロセスはWorkspaceを開かず終了し、既存Windowを前面へ戻します。",
          ),
        ]),
      ]),
      section("command-line", "Command-line", [
        paragraph(
          "command-picker",
          rich(
            code(",c"),
            "は共通検索ペインでCommandを選び、選択したcanonical nameを下部のCommand-lineへ転記します。",
            code(":"),
            "は空のCommand-lineを直接開きます。",
          ),
        ),
        {
          type: "codeBlock",
          attrs: {
            blockId: id("code-block:commands"),
            language: "text",
          },
          content: [
            {
              type: "text",
              text: APPLICATION_COMMANDS.map(
                ({ name, aliases, description }) =>
                  `:${name}${aliases.length > 0 ? ` (${aliases.map((alias) => `:${alias}`).join(", ")})` : ""} — ${description}`,
              ).join("\n"),
            },
          ],
        },
      ]),
      section("managed-help", "このHelpについて", [
        paragraph(
          "managed-help",
          rich(
            "このノートはMemokaが管理します。",
            code(":help"),
            "を再実行すると最新のSection構造と操作説明へ同期され、このノートへの手動変更は置き換えられます。問題報告とソースコードは",
            externalLink(
              "memoka-project/memoka",
              "https://github.com/memoka-project/memoka",
            ),
            "を参照してください。",
          ),
        ),
      ]),
    ],
  };
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
