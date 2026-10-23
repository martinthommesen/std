/** Router-equivalent API path classification, also for failed/unknown routes. */
import { FindMyWay } from "effect/http";

const classifiers = new WeakMap<
  Partial<FindMyWay.RouterConfig>,
  (url: string) => "std" | "tmf" | undefined
>();

/**
 * Classifies API paths using the same rules as the application router.
 * @param config - Application router configuration.
 * @returns A classifier built once per router configuration.
 */
export const apiKindOf = (
  config: Partial<FindMyWay.RouterConfig>
): ((url: string) => "std" | "tmf" | undefined) => {
  const existing = classifiers.get(config);

  if (existing !== undefined) {
    return existing;
  }

  const routes = FindMyWay.make<"std" | "tmf">(config);
  routes.all("/api/*", "std");
  routes.all("/tmf-api/*", "tmf");

  const lookup = routes.find.bind(routes);

  const classify = (path: string) => lookup("GET", path)?.handler;
  classifiers.set(config, classify);

  return classify;
};
