import { describe, expect, it } from "vitest";
import { parseEnvOutput } from "./login-env.js";

describe("parseEnvOutput", () => {
  it("reads the variables between the markers and drops rc-file noise", () => {
    const output = [
      "Welcome to zsh!",
      "__BLACKWALL_ENV__PATH=/usr/local/bin:/usr/bin",
      "HOME=/Users/me",
      "EMPTY=",
      "__BLACKWALL_ENV__",
      "bye",
    ].join("\n");
    expect(parseEnvOutput(output)).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/Users/me",
      EMPTY: "",
    });
  });

  it("appends continuation lines to the previous value", () => {
    const output = "__BLACKWALL_ENV__A=1\nMULTI=first\nsecond line\nB=x=y\n__BLACKWALL_ENV__";
    expect(parseEnvOutput(output)).toEqual({ A: "1", MULTI: "first\nsecond line", B: "x=y" });
  });

  it("is empty without both markers", () => {
    expect(parseEnvOutput("PATH=/usr/bin")).toEqual({});
    expect(parseEnvOutput("__BLACKWALL_ENV__PATH=/usr/bin")).toEqual({});
  });
});
