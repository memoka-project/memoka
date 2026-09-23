import { describe, expect, it } from "vitest";
import { allocateVimFindHintLabels } from "../app/src/vim/find-character";

describe("Normal find hint labels", () => {
  it("uses lowercase labels and reserves literal ASCII targets", () => {
    const labels = allocateVimFindHintLabels(40, new Set(["a", "s", "A"]));
    expect(labels).toHaveLength(40);
    expect(labels[0]).toBe("d");
    expect(labels.some((label) => label.length === 2)).toBe(true);
    expect(labels.every((label) => /^[a-z]{1,3}$/u.test(label))).toBe(true);
    expect(
      labels.every(
        (label) =>
          !label.startsWith("a") &&
          !label.startsWith("s") &&
          !label.startsWith("A"),
      ),
    ).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
    expect(
      labels.every((label) =>
        labels.every((other) => label === other || !other.startsWith(label)),
      ),
    ).toBe(true);
  });

  it("exhausts three-letter lowercase labels before assigning uppercase", () => {
    const lowercaseCapacity = 26 ** 3;
    const labels = allocateVimFindHintLabels(lowercaseCapacity + 1, new Set());
    expect(labels).toHaveLength(lowercaseCapacity + 1);
    expect(
      labels
        .slice(0, lowercaseCapacity)
        .every((label) => /^[a-z]{3}$/u.test(label)),
    ).toBe(true);
    expect(labels[lowercaseCapacity]).toBe("A");
    expect(new Set(labels).size).toBe(labels.length);
    expect(
      allocateVimFindHintLabels(
        30,
        new Set("abcdefghijklmnopqrstuvwxyzA"),
      ).every((label) => /^[B-Z][a-z]{0,2}$/u.test(label)),
    ).toBe(true);
    expect(
      allocateVimFindHintLabels(
        2,
        new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"),
      ),
    ).toEqual([]);
  });
});
