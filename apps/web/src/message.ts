import { CurrentSession } from "@std/api/session";
import { TableMetadataSummary } from "@std/api/table-metadata";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";

import { SchemaRevision } from "./domain/schema-revision.ts";
import { Message as RecordFormMessage } from "./page/record-form/message.ts";
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
  FailedAuthentication: { sessionId: Schema.Int },
  FailedLoadCurrentUser: {},
  FailedLoadTables: { sessionId: Schema.Int },
  FailedSignOut: { sessionId: Schema.Int },
  GotRecordFormMessage: { message: RecordFormMessage, pageId: Schema.Int },
  GotSignInMessage: { message: SignInMessage },
  GotTableListMessage: { message: TableListMessage, pageId: Schema.Int },
  SucceededLoadCurrentUser: {
    maybeRevision: Schema.Option(SchemaRevision),
    maybeUser: Schema.Option(CurrentSession),
  },
  SucceededLoadTables: {
    revision: SchemaRevision,
    sessionId: Schema.Int,
    tables: Schema.Array(TableMetadataSummary),
  },
  SucceededSignOut: { sessionId: Schema.Int },
});

/** What happens in the app. */
export type Message = typeof Message.Type;
