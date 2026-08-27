import { Fragment, Schema, Slice } from "@tiptap/pm/model";
import { describe, expect, it, vi } from "vitest";
import type { VimRegister } from "../app/src/vim/editor-commands";
import { VimRegisterStore } from "../app/src/vim/register-store";

function testSchema(): Schema {
  return new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "text*" },
      text: { group: "inline" },
    },
  });
}

describe("Memoka Workspace-session unnamed register", () => {
  it("rebuilds structural content against the destination schema", () => {
    const sourceSchema = testSchema();
    const destinationSchema = testSchema();
    const sourceNode = sourceSchema.nodes.paragraph.create(
      null,
      sourceSchema.text("shared"),
    );
    const register: VimRegister = {
      kind: "structure",
      text: "shared",
      structureKind: "block",
      nodeNames: ["paragraph"],
      slice: new Slice(Fragment.from(sourceNode), 0, 0),
    };
    const store = new VimRegisterStore();
    store.set(register);

    const restored = store.read(destinationSchema);
    expect(restored?.kind).toBe("structure");
    if (restored?.kind !== "structure") throw new Error("wrong register");
    expect(restored.slice.content.firstChild?.type).toBe(
      destinationSchema.nodes.paragraph,
    );
    expect(restored.slice.content.firstChild?.type).not.toBe(
      sourceSchema.nodes.paragraph,
    );
    expect(restored.slice.content.firstChild?.textContent).toBe("shared");
  });

  it("owns its metadata and notifies every live Window session", () => {
    const store = new VimRegisterStore();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = store.subscribe(first);
    store.subscribe(second);
    const register: VimRegister = {
      kind: "text",
      text: "one",
    };

    store.set(register);
    register.text = "mutated outside";
    expect(store.read()).toEqual({ kind: "text", text: "one" });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    unsubscribeFirst();
    store.clear();
    expect(store.read()).toBeNull();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  });
});
