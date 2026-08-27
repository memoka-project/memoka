import * as Y from "yjs";

/**
 * Returns only the user-visible characters stored by a Y.XmlText.
 *
 * Y.XmlText.toString() serializes formatting attributes as XML (for example,
 * an external Link becomes `<link href="...">label</link>`). Search and
 * semantic-empty projections must never expose that non-rendered markup or
 * use its length as a ProseMirror text offset.
 */
export function yXmlTextVisibleText(value: Y.XmlText): string {
  let result = "";
  for (const delta of value.toDelta()) {
    if (typeof delta.insert === "string") result += delta.insert;
  }
  return result;
}
