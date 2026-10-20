import {
  HttpApi,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";

/** A one-endpoint API, standing in for the shared `@std/api` definition. */
export class CanaryApi extends HttpApi.make("canary").add(
  HttpApiGroup.make("system", { topLevel: true }).add(
    HttpApiEndpoint.get("health", "/health", {
      success: HttpApiSchema.NoContent,
    })
  )
) {}

/** The typed client the web app builds from the shared definition. */
export const makeClient = HttpApiClient.make(CanaryApi);
