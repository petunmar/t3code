import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("enables structured user input in Build mode", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), [
      "app-server",
      "-c",
      "features.default_mode_request_user_input=true",
    ]);
  });

  it("applies the required app-server config after parsed launch args", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs("--strict-config -c features.default_mode_request_user_input=false"),
      [
        "app-server",
        "--strict-config",
        "-c",
        "features.default_mode_request_user_input=false",
        "-c",
        "features.default_mode_request_user_input=true",
      ],
    );
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});
