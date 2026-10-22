import { CurrentUserSchema } from "@std/api/session";
import { MetaTableSummarySchema } from "@std/definitions/table-metadata";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";

import { SchemaRevision } from "./domain/schema-revision.ts";
import { Message as SignInMessage } from "./page/sign-in/sign-in.ts";
import { Message as TableListMessage } from "./page/table-list/message.ts";

/** What happens in the app. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Message = defineMessageUnion({
  ChangedUrl: { url: Url },
  ClickedLink: { request: UrlRequest },
  ClickedRetrySessionCheck: {},
  ClickedSignOut: {},
  CompletedFocusMain: {},
  CompletedLoadExternal: {},
  CompletedNavigateInternal: {},
  CompletedReplaceUrl: {},
  FailedAuthentication: {},
  FailedLoadCurrentUser: {},
  FailedLoadTables: {},
  FailedSignOut: {},
  GotSignInMessage: { message: SignInMessage },
  GotTableListMessage: { message: TableListMessage },
  SucceededLoadCurrentUser: { maybeUser: Schema.Option(CurrentUserSchema) },
  SucceededLoadTables: {
    revision: SchemaRevision,
    tables: Schema.Array(MetaTableSummarySchema),
  },
  SucceededSignOut: {},
});

/** What happens in the app. */
export type Message = typeof Message.Type;
