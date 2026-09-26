import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SCAFFOLD_SCHEMA_SHA256, templateScaffoldSchema } from "@/lib/templates/scaffold-schema";

/**
 * Every module a source pulls in, found by TypeScript's own parser rather than
 * a regex: a multi-line import, a bare side-effect import, `export … from`,
 * `import x = require()`, `require()`, dynamic `import()` and a type-position
 * `import("…")` are all seen, while comments and string literals are not.
 * A call whose argument is not a string literal is reported as `<expr>`: it
 * cannot be vetted, so it fails the allowlist.
 */
function moduleReferences(src: string): string[] {
  const file = ts.createSourceFile("probe.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const record = (how: string, e: ts.Node | undefined) =>
    found.push(`${how} ${e && ts.isStringLiteralLike(e) ? e.text : `<${e?.getText(file) ?? ""}>`}`);
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n)) record("import", n.moduleSpecifier);
    else if (ts.isExportDeclaration(n) && n.moduleSpecifier) record("export-from", n.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      record("import-equals", n.moduleReference.expression);
    } else if (ts.isImportTypeNode(n)) {
      record("import-type", ts.isLiteralTypeNode(n.argument) ? n.argument.literal : n.argument);
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      record("dynamic-import", n.arguments[0]);
    } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require") {
      record("require", n.arguments[0]);
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return found;
}

const ONLY_ZOD = ["import zod/v3"];
const readSchemaFile = () => fs.readFileSync(path.resolve("lib/templates/scaffold-schema.ts"), "utf8");

describe("scaffold-schema.ts is the file libi-site copies", () => {
  it("imports zod/v3 and nothing else, in any form", () => {
    expect(moduleReferences(readSchemaFile())).toEqual(ONLY_ZOD);
  });

  describe("the import checker itself", () => {
    const zod = 'import { z } from "zod/v3";\n';
    it.each([
      ["a multi-line import", 'import {\n  CAPS,\n} from "@/lib/templates/cloud/constants";', "import @/lib/templates/cloud/constants"],
      ["a bare side-effect import", 'import "./x";', "import ./x"],
      ["a type-only import", 'import type { Foo } from "./foo";', "import ./foo"],
      ["require()", 'const fs = require("fs");', "require fs"],
      ["require() of a computed name", "const m = require(name);", "require <name>"],
      ["dynamic import()", 'const m = await import("./lazy");', "dynamic-import ./lazy"],
      ["dynamic import() of a computed name", "const m = await import(`./${n}`);", "dynamic-import <`./${n}`>"],
      ["export … from", 'export { a } from "./a";', "export-from ./a"],
      ["export * from", 'export * from "./b";', "export-from ./b"],
      ["import x = require()", 'import c = require("./c");', "import-equals ./c"],
      ["a type-position import()", 'type T = import("./t").T;', "import-type ./t"],
    ])("catches %s", (_label, line, expected) => {
      const refs = moduleReferences(zod + line);
      expect(refs).toContain(expected);
      expect(refs).not.toEqual(ONLY_ZOD);
    });
    it("ignores comments and strings that merely mention an import", () => {
      const src = `${zod}// const x = require("fs");\n/* import "./y"; */\nconst s = 'await import("./z")';\n`;
      expect(moduleReferences(src)).toEqual(ONLY_ZOD);
    });
  });

  it("matches its pinned hash — on a failure, read the comment above the pin before re-pinning", () => {
    const blanked = readSchemaFile().replace(/SCAFFOLD_SCHEMA_SHA256 = "[0-9a-f]*"/, 'SCAFFOLD_SCHEMA_SHA256 = ""');
    expect(createHash("sha256").update(blanked).digest("hex")).toBe(SCAFFOLD_SCHEMA_SHA256);
  });
  it("still validates a minimal scaffold", () => {
    expect(templateScaffoldSchema.safeParse({ schema: 2 }).success).toBe(false);
  });
});
