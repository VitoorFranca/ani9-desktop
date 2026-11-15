import { describe, expect, it } from "vitest";
import { MAX_NOTICES, addNotice, removeNotice } from "../src/main/noticeList.js";

describe("notice list", () => {
  it("replaces a notice with the same tag and keeps the latest few", () => {
    let list = addNotice([], { tag: "a", title: "1" });
    list = addNotice(list, { tag: "b", title: "2" });
    list = addNotice(list, { tag: "a", title: "3" });
    expect(list.map((n) => n.title)).toEqual(["2", "3"]);
    for (const tag of ["c", "d", "e"]) list = addNotice(list, { tag, title: tag });
    expect(list.map((n) => n.tag)).toEqual(["c", "d", "e"]);
    expect(list).toHaveLength(MAX_NOTICES);
  });

  it("removes by tag and says what was removed", () => {
    const { list, removed } = removeNotice(
      [
        { tag: "a", title: "1" },
        { tag: "b", title: "2" },
      ],
      "a",
    );
    expect(removed).toEqual({ tag: "a", title: "1" });
    expect(list).toEqual([{ tag: "b", title: "2" }]);
    expect(removeNotice(list, "zz").removed).toBeNull();
  });
});
