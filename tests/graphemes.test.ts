import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { defaultVimBlockSemantics } from "../app/src/vim/block-semantics";
import { graphemeEnd, previousGraphemeStart } from "../app/src/vim/graphemes";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    codeBlock: { group: "block", content: "text*" },
    text: {},
  },
  marks: { strong: {} },
});

describe("grapheme boundaries", () => {
  it.each(["paragraph", "codeBlock"])(
    "keeps clusters intact across marks in %s",
    (type) => {
      const node = schema.node(type, null, [
        schema.text("a👨"),
        schema.text("‍👩‍👧‍👦", [schema.mark("strong")]),
        schema.text("b"),
      ]);
      const doc = schema.node("doc", null, [node]);
      const view = { state: EditorState.create({ doc }) };
      const line = defaultVimBlockSemantics.logicalLines(view)[0]!;
      expect(line.cursorPositions).toEqual([1, 2, 13]);
      expect(graphemeEnd(doc, 2)).toBe(13);
      expect(previousGraphemeStart(doc, 13)).toBe(2);
    },
  );
});
