import { HttpApi } from "effect/http-api";

import { StdApiV2 } from "./api.ts";

const prefixOf = (): `/${string}` => {
  let prefix = "";
  HttpApi.reflect(StdApiV2, {
    onEndpoint: ({ endpoint, group }) => {
      if (group.identifier === "hub" && endpoint.identifier === "register") {
        prefix = endpoint.path.slice(0, -"/hub".length);
      }
    },
    onGroup: () => {
      /* Only endpoint paths determine the prefix. */
    },
  });

  if (!prefix.startsWith("/")) {
    throw new Error("The shared API must have an absolute prefix");
  }

  return `/${prefix.slice(1)}`;
};

/** Derived from the shared API definition, including across an API rename. */
export const GENERIC_API_PREFIX = prefixOf();
