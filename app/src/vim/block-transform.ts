import {
  Fragment,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { createUuidV7 } from "../core/ids";
import { editableBlockById } from "../editor/block-container";
import type {
  BlockTransformOptions,
  BlockTransformTarget,
  TableDimensions,
} from "../core/block-types";
import {
  normalizeMarkdownAlertFold,
  normalizeMarkdownAlertTitle,
  normalizeMarkdownAlertType,
} from "../core/markdown-alert";

export interface BlockTransformCommand {
  readonly name: "block.transform";
  readonly payload: {
    readonly blockId: string;
    readonly target: BlockTransformTarget;
    /** The slash picker may consume the otherwise empty Paragraph's `/`. */
    readonly consumeSlash?: boolean;
    readonly options?: BlockTransformOptions;
  };
}

export type BlockTransformResult =
  | {
      readonly changed: true;
      readonly target: BlockTransformTarget;
      readonly selection: "text" | "node";
    }
  | {
      readonly changed: false;
      readonly reason:
        | "missing"
        | "not-direct-body"
        | "stale-slash"
        | "unsupported"
        | "unsafe-inline-content"
        | "no-op";
    };

export function runBlockTransformCommand(
  view: EditorView,
  command: BlockTransformCommand,
): BlockTransformResult {
  const source = editableBlockById(view.state.doc, command.payload.blockId);
  if (!source) {
    return blockExists(view.state.doc, command.payload.blockId)
      ? { changed: false, reason: "not-direct-body" }
      : { changed: false, reason: "missing" };
  }
  if (
    command.payload.consumeSlash &&
    (source.node.type.name !== "paragraph" || source.node.textContent !== "/")
  ) {
    return { changed: false, reason: "stale-slash" };
  }

  const replacement = createReplacement(
    view.state.schema,
    source.node,
    command.payload.target,
    command.payload.consumeSlash === true,
    command.payload.options,
  );
  if ("reason" in replacement) return replacement;
  if (
    !source.parent.canReplaceWith(
      source.index,
      source.index + 1,
      replacement.node.type,
    )
  ) {
    return { changed: false, reason: "unsupported" };
  }

  const transaction = view.state.tr.replaceWith(
    source.position,
    source.position + source.node.nodeSize,
    replacement.node,
  );
  const replacementPosition = transaction.mapping.map(source.position, -1);
  if (replacement.selection === "node") {
    transaction.setSelection(
      NodeSelection.create(transaction.doc, replacementPosition),
    );
  } else {
    transaction.setSelection(
      TextSelection.near(transaction.doc.resolve(replacementPosition + 1)),
    );
  }
  transaction.setMeta("memoka.block.transform", command.payload.target);
  view.dispatch(transaction);
  return {
    changed: true,
    target: command.payload.target,
    selection: replacement.selection,
  };
}

function createReplacement(
  schema: Schema,
  source: ProseMirrorNode,
  target: BlockTransformTarget,
  consumeSlash: boolean,
  options?: BlockTransformOptions,
):
  | { readonly node: ProseMirrorNode; readonly selection: "text" | "node" }
  | Extract<BlockTransformResult, { changed: false }> {
  const sourceType = source.type.name;
  const supportedTextSource =
    sourceType === "paragraph" ||
    sourceType === "codeBlock" ||
    sourceType === "sourceBlock";
  const supportedListSource =
    sourceType === "bulletList" || sourceType === "orderedList";
  if (!supportedTextSource && !supportedListSource) {
    return { changed: false, reason: "unsupported" };
  }

  if (supportedListSource) {
    if (
      target === sourceType &&
      !Array.from({ length: source.childCount }, (_, i) =>
        source.child(i),
      ).some((item) => typeof item.attrs.checked === "boolean")
    )
      return { changed: false, reason: "no-op" };
    if (
      target !== "bulletList" &&
      target !== "orderedList" &&
      target !== "taskList"
    ) {
      return { changed: false, reason: "unsupported" };
    }
    const listType =
      schema.nodes[target === "taskList" ? "bulletList" : target];
    if (!listType) return { changed: false, reason: "unsupported" };
    return {
      node: listType.create(
        target === "orderedList"
          ? { ...source.attrs, blockId: source.attrs.blockId, start: 1 }
          : { ...source.attrs, blockId: source.attrs.blockId },
        Fragment.fromArray(
          Array.from({ length: source.childCount }, (_, i) => {
            const item = source.child(i);
            return item.type.create(
              {
                ...item.attrs,
                checked:
                  target === "taskList" ? (item.attrs.checked ?? false) : null,
              },
              item.content,
              item.marks,
            );
          }),
        ),
      ),
      selection: "text",
    };
  }

  if (target === sourceType && !consumeSlash) {
    return { changed: false, reason: "no-op" };
  }
  const blockId = source.attrs.blockId;
  const plainText = consumeSlash ? "" : textBlockPlainText(source);
  if (
    sourceType === "paragraph" &&
    (target === "codeBlock" || target === "sourceBlock") &&
    hasUnsafeInlineContent(source)
  ) {
    return { changed: false, reason: "unsafe-inline-content" };
  }

  if (target === "paragraph") {
    const paragraph = schema.nodes.paragraph;
    if (!paragraph) return { changed: false, reason: "unsupported" };
    const content =
      sourceType === "paragraph" && !consumeSlash
        ? source.content
        : paragraphInlineContent(schema, plainText);
    return {
      node: paragraph.create({ blockId }, content),
      selection: "text",
    };
  }
  if (target === "codeBlock" || target === "sourceBlock") {
    const type = schema.nodes[target];
    if (!type) return { changed: false, reason: "unsupported" };
    return {
      node: type.create(
        target === "sourceBlock"
          ? { blockId, sourceFormat: "markdown" }
          : { blockId, language: null },
        plainText ? schema.text(plainText) : undefined,
      ),
      selection: "text",
    };
  }
  if (
    target === "bulletList" ||
    target === "orderedList" ||
    target === "taskList"
  ) {
    const list = schema.nodes[target === "taskList" ? "bulletList" : target];
    const item = schema.nodes.listItem;
    const paragraph = schema.nodes.paragraph;
    if (!list || !item || !paragraph) {
      return { changed: false, reason: "unsupported" };
    }
    const paragraphContent =
      sourceType === "paragraph" && !consumeSlash
        ? source.content
        : paragraphInlineContent(schema, plainText);
    const innerParagraph = paragraph.create(
      { blockId: createUuidV7() },
      paragraphContent,
    );
    const listItem = item.create(
      {
        blockId: createUuidV7(),
        checked: target === "taskList" ? false : null,
      },
      innerParagraph,
    );
    return {
      node: list.create(
        target === "orderedList" ? { blockId, start: 1 } : { blockId },
        listItem,
      ),
      selection: "text",
    };
  }
  if (target === "table") {
    if (!consumeSlash && (sourceType !== "paragraph" || source.content.size)) {
      return { changed: false, reason: "unsupported" };
    }
    const table = createEmptyTable(schema, blockId, options?.tableDimensions);
    return table
      ? { node: table, selection: "text" }
      : { changed: false, reason: "unsupported" };
  }
  if (target === "horizontalRule") {
    const type = schema.nodes.horizontalRule;
    if (!type || plainText) return { changed: false, reason: "unsupported" };
    return { node: type.create({ blockId }), selection: "node" };
  }
  if (target === "details") {
    const { details, detailsSummary, detailsBody, paragraph } = schema.nodes;
    if (!details || !detailsSummary || !detailsBody || !paragraph)
      return { changed: false, reason: "unsupported" };
    const content =
      sourceType === "paragraph" && !consumeSlash
        ? source.content
        : paragraphInlineContent(schema, plainText);
    return {
      node: details.createChecked({ blockId, open: true }, [
        detailsSummary.createChecked({ blockId: createUuidV7() }, content),
        detailsBody.createChecked(
          { blockId: createUuidV7() },
          paragraph.create({ blockId: createUuidV7() }),
        ),
      ]),
      selection: "text",
    };
  }
  if (target === "alert" || target === "blockquote") {
    const blockquote = schema.nodes.blockquote;
    const paragraph = schema.nodes.paragraph;
    const alertType = normalizeMarkdownAlertType(
      options?.alert?.type ?? "note",
    );
    if (!blockquote || !paragraph || !alertType) {
      return { changed: false, reason: "unsupported" };
    }
    const paragraphContent =
      sourceType === "paragraph" && !consumeSlash
        ? source.content
        : paragraphInlineContent(schema, plainText);
    return {
      node: blockquote.create(
        {
          blockId,
          alertType: target === "alert" ? alertType : null,
          alertTitle: normalizeMarkdownAlertTitle(options?.alert?.title),
          alertFold: normalizeMarkdownAlertFold(options?.alert?.fold),
        },
        paragraph.create({ blockId: createUuidV7() }, paragraphContent),
      ),
      selection: "text",
    };
  }
  if (target === "image") {
    if (!consumeSlash && (sourceType !== "paragraph" || source.content.size)) {
      return { changed: false, reason: "unsupported" };
    }
    const image = schema.nodes.image;
    if (!image) return { changed: false, reason: "unsupported" };
    return {
      node: image.create({
        blockId,
        src: "attachment:missing",
        attachmentId: "attachment:missing",
        alt: "Image Block stub",
        title: null,
        alignment: "center",
        width: null,
      }),
      selection: "node",
    };
  }
  return { changed: false, reason: "unsupported" };
}

function blockExists(doc: ProseMirrorNode, blockId: string): boolean {
  let found = false;
  doc.descendants((node) => {
    if (node.attrs.blockId === blockId) found = true;
    return !found;
  });
  return found;
}

function textBlockPlainText(node: ProseMirrorNode): string {
  let result = "";
  node.descendants((child) => {
    if (child.isText) result += child.text ?? "";
    else if (child.type.name === "hardBreak") result += "\n";
    return true;
  });
  return result;
}

function hasUnsafeInlineContent(node: ProseMirrorNode): boolean {
  let unsafe = false;
  node.descendants((child) => {
    if (child.type.name === "internalSectionLink" || child.marks.length > 0) {
      unsafe = true;
      return false;
    }
    return true;
  });
  return unsafe;
}

function paragraphInlineContent(
  schema: Schema,
  text: string,
): readonly ProseMirrorNode[] {
  if (!text) return [];
  const hardBreak = schema.nodes.hardBreak;
  const parts = text.split("\n");
  const content: ProseMirrorNode[] = [];
  parts.forEach((part, index) => {
    if (index > 0 && hardBreak) content.push(hardBreak.create());
    if (part) content.push(schema.text(part));
  });
  return content;
}

function createEmptyTable(
  schema: Schema,
  blockId: string,
  dimensions: TableDimensions = { rows: 3, columns: 3 },
): ProseMirrorNode | null {
  const table = schema.nodes.table;
  const row = schema.nodes.tableRow;
  const header = schema.nodes.tableHeader;
  const cell = schema.nodes.tableCell;
  const paragraph = schema.nodes.paragraph;
  if (!table || !row || !header || !cell || !paragraph) return null;
  const rowCount = normalizedTableDimension(dimensions.rows);
  const columnCount = normalizedTableDimension(dimensions.columns);
  if (rowCount === null || columnCount === null) return null;
  const rows = Array.from({ length: rowCount }, (_, rowIndex) => {
    const cellType = rowIndex === 0 ? header : cell;
    return row.create(
      { blockId: createUuidV7() },
      Array.from({ length: columnCount }, () =>
        cellType.create(
          { blockId: createUuidV7(), alignment: null },
          paragraph.create({ blockId: createUuidV7() }),
        ),
      ),
    );
  });
  return table.create({ blockId }, rows);
}

function normalizedTableDimension(value: number): number | null {
  if (!Number.isInteger(value) || value < 1 || value > 50) return null;
  return value;
}
