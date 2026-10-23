/** Explicit authority for the set loader's audited service-identity repairs. */
import { Context, Layer } from "effect";

/** Only provisioning paths supply this service; an actor ID grants no bypass. */
export class ServiceIdentityProvisioning extends Context.Service<
  ServiceIdentityProvisioning,
  { readonly provision: true }
>()("@std/server/auth/ServiceIdentityProvisioning") {
  static readonly layer = Layer.succeed(ServiceIdentityProvisioning, {
    provision: true,
  });
}
