import { CurrentUserSchema } from "@std/api/session";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";

import { Message as SignInMessage } from "./page/sign-in/sign-in.ts";

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
  FailedLoadCurrentUser: {},
  FailedSignOut: {},
  GotSignInMessage: { message: SignInMessage },
  SucceededLoadCurrentUser: { maybeUser: Schema.Option(CurrentUserSchema) },
  SucceededSignOut: {},
});

/** What happens in the app. */
export type Message = typeof Message.Type;
