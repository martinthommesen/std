/**
 * Stable IDs that code refers to directly. They are fixed in the `core`
 * definition set files (`packages/server/definitions/core/`) as well, and a
 * test checks both agree. Platform migrations use the platform class IDs in
 * the subtree CHECK of each platform table, so these values never change.
 */
import type { DefinitionId } from "./ids.ts";

/** The `core` definition set. */
export const CORE_SET_ID: DefinitionId = "9ca926e7-2dc2-46e6-af99-af0638e5d3ea";

/** The `core` namespace (the `core` Postgres schema, created by migration 0001). */
export const CORE_NAMESPACE_ID: DefinitionId =
  "dd189f1d-099a-428c-8a56-ab94b60c933e";

/** Class IDs of the platform tables, by table name in the `core` schema. */
export const PLATFORM_CLASS_IDS = {
  access_rule: "051b98ff-3fc2-4155-a6e8-b3d9053a5b9e",
  change: "edde151d-f204-4639-bcbf-a4793f86a219",
  choice: "633ddece-067a-4340-a43d-8dd8ae45b294",
  class: "7a8a7202-1e01-4d77-bf6f-4ff80876bef6",
  config_base: "aa13ec55-456b-415b-aab5-ef9c42438f16",
  config_conflict: "b7281780-9441-46f3-9d58-f14b812a59c2",
  config_override: "225c71f0-e411-4e5e-a01c-aebdd779a2c5",
  config_set: "0b70df4d-c000-4b9a-aa7f-8b5b92f1afce",
  field: "de5ad84a-87aa-45a0-b76b-2ce287e306c2",
  field_override: "e29c0472-668e-40ff-bb0c-8ffa8e8b6f37",
  index: "3e7e3e31-2fef-4414-9c85-e37a441a8809",
  layout: "ae98b973-f436-4315-a093-057af79dbc5c",
  namespace: "53500c6c-063b-423a-b626-a6a938649162",
  permission: "0d6333e6-d241-4da7-a456-5cafd70db0a4",
  record_rule: "72bd1370-a1dd-4a67-b8ed-efc66b50fe43",
  role: "a425953f-b934-47d6-8ff1-4bbeca1b9370",
  role_permission: "b16789cc-353b-4f92-9f9a-3683a7f8ec0e",
  saved_filter: "b3ac8bad-2b77-4610-9d09-816af6d2c8d4",
  schema_change: "b176d598-bd9d-4b4d-8dd9-87b52eaf992e",
  schema_change_step: "3d49bff3-7640-48b7-9030-d37b68f8b639",
  subscription: "31446f0c-7ec7-4e5a-a1b4-f4a4686bca0e",
} as const satisfies Readonly<Record<string, DefinitionId>>;

/**
 * The config kinds a subscription may watch (Contracts 4.6, config
 * subscriptions): `core.role` and `core.access_rule`. Change sets write
 * their deliveries; every other platform table is refused.
 */
export const CONFIG_SUBSCRIPTION_CLASS_IDS: ReadonlySet<DefinitionId> = new Set(
  [PLATFORM_CLASS_IDS.role, PLATFORM_CLASS_IDS.access_rule]
);

/** A platform table name. */
export type PlatformTable = keyof typeof PLATFORM_CLASS_IDS;

/** `core.user`, created by the core set. */
export const USER_CLASS_ID: DefinitionId =
  "da385db7-b2b7-4a1d-a1a9-42e8e0bb7992";

/** `core.user_role`, created by the core set. */
export const USER_ROLE_CLASS_ID: DefinitionId =
  "cc91a08a-b885-4878-ad82-dd4a806bc787";

/**
 * The system user: the actor of bootstrap and definition loading
 * (Contracts 3.1). Its `core.user` row is inserted in the change set that
 * creates `core.user`; it is inactive and cannot sign in.
 */
export const SYSTEM_USER_ID: DefinitionId =
  "1970f1d9-a830-4414-ba8e-210e07952a85";

/** Built-in roles (Contracts 3.1). */
export const BUILT_IN_ROLE_IDS = {
  admin: "8e67ee7f-106e-48f9-a8ff-b494fd0999e5",
  authenticated: "400765a2-d13e-4926-bbf5-b89fd448054c",
  schema_purger: "e5798e3e-7bbb-46e5-94a1-5e94be04c372",
} as const satisfies Readonly<Record<string, DefinitionId>>;

/** The ID of the built-in `schema.purge` permission (Contracts 1.6, 3.1). */
export const SCHEMA_PURGE_PERMISSION_ID: DefinitionId =
  "ba9fb2e0-d28d-4f77-aeaf-dab447f3f8a9";

/**
 * The ID of the built-in `rules.run_as` permission (Contracts 3.1, 4.1):
 * a record rule may run as another identity only when its author holds it.
 */
export const RULES_RUN_AS_PERMISSION_ID: DefinitionId =
  "6de89171-f738-4ade-aa1b-2817f848899c";

/** Built-in permissions (Contracts 3.1), checked by ID. */
export const PERMISSION_IDS = {
  "events.subscribe": "482cfac8-dc92-4637-a8cb-ce4eaf01233d",
  "rules.run_as": RULES_RUN_AS_PERMISSION_ID,
  "schema.purge": SCHEMA_PURGE_PERMISSION_ID,
  "schema.snapshot": "f84a7851-ccdb-4c84-8363-6cf2c1078520",
} as const satisfies Readonly<Record<string, DefinitionId>>;

/** Fields of `core.user` that code reads (sign-in, sessions, labels). */
export const USER_FIELD_IDS = {
  active: "df9bb372-d557-445c-a173-66ab4e7a9c7c",
  /** The user's individual (Contracts 11.3), read-only, unique. */
  individual: "e8d96833-a256-4f38-8752-3f7b5fde3afd",
  login: "b3cabaa4-77cb-4845-9221-2105b21425eb",
  name: "13160bfb-1a94-4f0b-a29b-bccf701673c0",
  // oxlint-disable-next-line sonarjs/no-hardcoded-passwords -- a field's stable ID, not a password
  password: "e122cfbe-11ea-4469-8c9b-14f4eab4aa74",
} as const satisfies Readonly<Record<string, DefinitionId>>;

/** Fields of `core.user_role` that code reads (effective roles). */
export const USER_ROLE_FIELD_IDS = {
  role: "9640bd3e-c66e-4b43-8b4c-31489d37dfc8",
  user: "f60c3043-b965-42f2-b9ea-a81c3f3ee84d",
} as const satisfies Readonly<Record<string, DefinitionId>>;

/** The party classes of the core set (Contracts 11.3, decision 0024). */
export const PARTY_CLASS_IDS = {
  individual: "a1d5e868-1a22-4b6e-8a65-605e046f24ab",
  organization: "f94b83bf-19a4-4793-b06f-d5b4b0727fac",
  party: "566904e7-72b9-455a-8ea1-5df797c43ae9",
} as const satisfies Readonly<Record<string, DefinitionId>>;

/** Fields of `core.party` and `core.individual` that code reads and sets. */
export const PARTY_FIELD_IDS = {
  familyName: "bd493796-8b5e-4907-9e12-6a047dac62e7",
  givenName: "f41d3f02-c469-428e-85cb-c6f55a2902de",
  name: "7292e739-5395-415e-a5b6-138c247bad45",
} as const satisfies Readonly<Record<string, DefinitionId>>;
