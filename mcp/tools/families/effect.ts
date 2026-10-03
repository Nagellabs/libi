import { z } from "zod/v3";
import { notify } from "@/mcp/notify";
import * as tools from "@/mcp/tools";
import {
  listEffectsSchema,
  addEffectSchema,
  updateEffectSchema,
  removeEffectSchema,
  listEffectPackagesSchema,
  installEffectFromGitSchema,
} from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";
import type { AnyToolResult } from "@/mcp/tools/types";

// `list` filters by the literal family "animation"; `add` takes any string (the handler checks it).
// `params` and `manifest` are advertised loosely (the full shape is in their text); each action still validates the whole shape.
const widen = { family: z.string(), params: z.array(z.record(z.unknown())), manifest: z.record(z.unknown()) };

function refreshingCustom(result: AnyToolResult): AnyToolResult {
  if (result.success) notify.refreshQuery({ queryKey: "effects-custom" });
  return result;
}

export const effectTool: ActionToolDef = {
  name: "libi.effect",
  description:
    "The animation EFFECT library: list built-in effects (kinds, in/out/loop phases, params) and installed custom packages; author, update, remove or install_from_git a custom effect (manifest + animate.js). Actions: list, list_packages, add, update, remove, install_from_git. To PUT an effect on a layer use libi.layer_effect.",
  widen,
  props: {
    id: "Custom effect id (add: a lowercase slug, e.g. 'slow-drift').",
    params: "[{ key, label, type: 'number'|'enum', min?, max?, step?, default?, options? }]",
    manifest: "Partial patch of { name, family, phases, supports, params, defaultDurationMs } (omit to keep it).",
    source: "animate.js body: a pure (progress, params) → TransformDelta function (math helpers only; no canvas, ctx or IO). update: omit to keep the existing one.",
  },
  actions: {
    list: action({
      describe:
        "built-in effects with supported layer kinds, phases and params, filtered by `kind` / `phase` / `family`: the AUTHORITATIVE current set (customs included), prefer it over memorized names",
      schema: listEffectsSchema,
      run: (params) => tools.listEffectsTool(params),
    }),
    list_packages: action({
      describe: "installed custom packages with validity (id, name, valid, error?)",
      schema: listEffectPackagesSchema,
      run: () => tools.listEffectPackagesTool(),
    }),
    add: action({
      describe:
        "author a custom effect: manifest fields + an animate.js `source`. Validated before any write (a failure persists nothing; the error is in data.hint); then apply it with libi.layer_effect by its id",
      schema: addEffectSchema,
      run: async (params) => refreshingCustom(await tools.addEffectTool(params)),
    }),
    update: action({
      describe:
        "patch a custom package's `source` and/or `manifest`; re-validated, a bad patch leaves the package intact",
      schema: updateEffectSchema,
      run: async (params) => refreshingCustom(await tools.updateEffectTool(params)),
    }),
    remove: action({
      describe: "delete a custom effect package by id",
      schema: removeEffectSchema,
      run: async (params) => refreshingCustom(await tools.removeEffectTool(params)),
    }),
    install_from_git: action({
      describe:
        "install a package from a git repo `url` (manifest.json + animate.js), sandbox-validated before persisting; then use its id with libi.layer_effect",
      schema: installEffectFromGitSchema,
      run: async (params) => refreshingCustom(await tools.installEffectFromGitTool(params)),
    }),
  },
};
