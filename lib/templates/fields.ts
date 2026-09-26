/**
 * The ALLOWLISTS a template's contents pass through (spec §3.5: unknown fields
 * are stripped), under the name the app has always imported them by.
 *
 * They are DEFINED in `lib/templates/scaffold-schema.ts` — the dependency-free
 * file libi-site copies byte-for-byte — because the scaffold schema applies
 * them and that file may import nothing but zod. Edit them there; the reasons
 * for what each list leaves out are documented beside them.
 *
 * Client-safe: no fs, no db.
 */
export {
  OVERLAY_KEYS_BY_KIND,
  CLIP_KEYS,
  pickKeys,
  captionStyleFieldsSchema,
  captionStyleFields,
  type CaptionStyleFields,
} from "@/lib/templates/scaffold-schema";
