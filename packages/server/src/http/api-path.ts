/** Router-equivalent API path classification, also for failed/unknown routes. */
import { FindMyWay } from "effect/http";

/**
 * Classifies API paths using the same rules as the application router.
 * @param url - Incoming request URL.
 * @param config - Application router configuration.
 * @returns STD API, TMF API, or a non-API path.
 */
export const apiKindOf = (
  url: string,
  config: Partial<FindMyWay.RouterConfig>
): "std" | "tmf" | undefined => {
  const routes = FindMyWay.make<"std" | "tmf">(config);
  routes.all("/api/*", "std");
  routes.all("/tmf-api/*", "tmf");

  const lookup = routes.find.bind(routes);

  return lookup("GET", url)?.handler;
};
