/**
 * The schema revision on the wire (Contracts 6.2): `<n>.<change_set_id>`,
 * the form every API response's `STD-Schema-Revision` header carries and
 * every request of the web app sends back. The number orders revisions;
 * the change set tells apart two databases that reached the same number
 * through different changes (after a restore).
 */
import { Option, Schema } from "effect";

const REVISION_TEXT = /^(?<number>0|[1-9]\d*)\.(?<changeSet>\S+)$/u;

/** A schema revision as the header carries it: `<n>.<change_set_id>`. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const SchemaRevision = Schema.String.pipe(
  Schema.check(Schema.isPattern(REVISION_TEXT)),
  Schema.brand("SchemaRevision")
);

/** A schema revision as the header carries it. */
export type SchemaRevision = typeof SchemaRevision.Type;

const decodeRevision = Schema.decodeUnknownOption(SchemaRevision);

/**
 * Reads a `STD-Schema-Revision` header value.
 *
 * @param header - The header's value, if the response had one.
 * @returns The revision, or none when absent or malformed.
 */
export const parseSchemaRevision = (
  header: string | undefined
): Option.Option<SchemaRevision> =>
  header === undefined ? Option.none() : decodeRevision(header.trim());

/**
 * The revision number of a revision.
 *
 * @param revision - The revision.
 * @returns Its `<n>`.
 */
export const revisionNumber = (revision: SchemaRevision): number =>
  Number(REVISION_TEXT.exec(revision)?.groups?.number ?? "0");

/**
 * Whether a revision a response showed should replace one the app holds:
 * a higher number, or the same number reached through another change set
 * (a restored database). A lower number is an earlier response arriving
 * late, and never moves the app back.
 *
 * @param seen - The revision a response showed.
 * @param held - The revision the app holds.
 * @returns True when `seen` is newer.
 */
export const isNewerRevision = (
  seen: SchemaRevision,
  held: SchemaRevision
): boolean =>
  revisionNumber(seen) > revisionNumber(held) ||
  (revisionNumber(seen) === revisionNumber(held) && seen !== held);

/**
 * The later of a held revision and one a response showed.
 *
 * @param maybeHeld - The revision held, if any.
 * @param seen - The revision a response showed.
 * @returns The one to keep.
 */
export const latestRevision = (
  maybeHeld: Option.Option<SchemaRevision>,
  seen: SchemaRevision
): SchemaRevision =>
  Option.match(maybeHeld, {
    onNone: () => seen,
    onSome: (held) => (isNewerRevision(seen, held) ? seen : held),
  });

/** A response without `STD-Schema-Revision`, which every API response has. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class MissingRevision extends Schema.TaggedError<
  MissingRevision,
  { readonly brand: unique symbol }
>()("MissingRevision", {}) {}
