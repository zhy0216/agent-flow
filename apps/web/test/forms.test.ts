import { expect, test } from "bun:test";
import { parseProject } from "@agent-flow/contracts";
import { formatCommands, parseCheckCommands } from "../src/forms";

test("command formatting round trips quoted, escaped, empty and multiline argv", () => {
  const checks = [
    [
      "bun",
      "test",
      "",
      "  ",
      'a"b',
      "it's",
      "C:\\new\\test",
      "\\n",
      "line\nbreak\r\n",
      "\t\b\f",
      "你好🙂",
      "$(id)",
      "`id`",
      "$HOME",
      "|;&<>",
    ],
    ["git", "diff", "--check"],
  ];
  const formatted = formatCommands(checks);
  expect(formatted.split("\n")).toHaveLength(2);
  expect(formatted).toContain('""');
  expect(formatted).toContain('"line\\nbreak\\r\\n"');
  expect(parseCheckCommands(formatted)).toEqual(checks);
  expect(
    parseProject({
      name: "Repo",
      repoKey: "repo",
      checks: parseCheckCommands(formatted),
    }).checks,
  ).toEqual(checks);
  expect(parseCheckCommands(formatCommands([]))).toEqual([]);
});

test("command text parses quote fragments, literal single quotes and unquoted escapes", () => {
  expect(
    parseCheckCommands(
      String.raw`bun test "" '' 'C:\new\test' "line\nbreak" "\u4f60\u597d" pre"mid dle"post escaped\ space \$HOME`,
    ),
  ).toEqual([
    [
      "bun",
      "test",
      "",
      "",
      "C:\\new\\test",
      "line\nbreak",
      "你好",
      "premid dlepost",
      "escaped space",
      "$HOME",
    ],
  ]);
  expect(
    parseCheckCommands(" \n bun \"line\nbreak\"\n\n git 'single\nquote'\r\n"),
  ).toEqual([
    ["bun", "line\nbreak"],
    ["git", "single\nquote"],
  ]);
});

test.each([
  "bun test | git status",
  "bun test && git status",
  "bun test; git status",
  "bun $(id)",
  "bun `id`",
  "bun $HOME",
  "bun > result",
])("command text rejects shell control syntax: %s", (text) => {
  expect(() => parseCheckCommands(text)).toThrow("不支持管道或变量展开");
});

test.each([
  ["npm test", "program must be bun or git"],
  ['"" test', "program must be bun or git"],
  ["bun a\0b", "NUL"],
  [String.raw`bun "\u0000"`, "NUL"],
  ['bun "unfinished', "未闭合"],
  ["bun trailing\\", "未闭合"],
  [String.raw`bun "\q"`, "无效转义"],
  [String.raw`bun "\u00xx"`, "无效转义"],
  [Array.from({ length: 21 }, () => "bun test").join("\n"), "at most 20"],
  [`bun ${Array.from({ length: 50 }, () => '""').join(" ")}`, "1 to 50"],
  [`bun ${"x".repeat(1001)}`, "at most 1000"],
])(
  "command text shares argv validation and rejects malformed quoting %#",
  (text, message) => {
    expect(() => parseCheckCommands(text)).toThrow(message);
  },
);
