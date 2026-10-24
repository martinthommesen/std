import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Ref, Schema } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

// Decode only what this consumer uses. Preserve the rest for inspection and
// replay, including merge-patch nulls and whole arrays (Contracts 12.1).
const Notification = Schema.Struct({
  "@type": Schema.NonEmptyString,
  event: Schema.Struct({
    troubleTicket: Schema.Struct({
      id: Schema.String.check(Schema.isUUID()),
      status: Schema.optionalKey(Schema.String),
    }),
  }),
  eventId: Schema.String.check(Schema.isUUID(5)),
  eventType: Schema.Literals([
    "TroubleTicketCreateEvent",
    "TroubleTicketAttributeValueChangeEvent",
    "TroubleTicketStatusChangeEvent",
    "TroubleTicketResolvedEvent",
    "TroubleTicketInformationRequiredEvent",
    "TroubleTicketDeleteEvent",
  ]),
});

interface Receipt {
  readonly notification: Schema.Json;
  readonly idempotencyKey: string;
  readonly duplicates: number;
}

/**
 * Starts the local TMF621 listener, closed with its scope. Its HTTP interface is
 * POST /listener (202, including duplicates) and GET /receipts (first bodies and
 * duplicate counts). Receipts live until the process stops; no eviction or TTL.
 * @param port - TCP port; zero lets the OS choose a free port.
 * @returns The loopback origin. No credentials are accepted or logged.
 */
export const startListener = Effect.fn("Listener.start")(
  function* startListener(port: number) {
    const receipts = yield* Ref.make<ReadonlyMap<string, Receipt>>(new Map());

    const server = yield* NodeHttpServer.make(createServer, {
      host: "127.0.0.1",
      port,
    });

    yield* server.serve(
      Effect.gen(function* handleRequest() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const [path] = request.url.split("?");

        if (request.method === "GET" && path === "/receipts") {
          const current = yield* Ref.get(receipts);

          return HttpServerResponse.jsonUnsafe([...current.values()]);
        }

        if (request.method !== "POST" || path !== "/listener") {
          return HttpServerResponse.empty({ status: 404 });
        }

        const body = yield* request.json;

        const notification =
          yield* Schema.decodeUnknownEffect(Notification)(body);

        const key = request.headers["idempotency-key"];

        if (
          key !== notification.eventId ||
          notification["@type"] !== notification.eventType
        ) {
          return HttpServerResponse.jsonUnsafe(
            {
              error:
                "Idempotency-Key must equal eventId; @type must equal eventType.",
            },
            { status: 400 }
          );
        }

        // One atomic transition before any yielding work: concurrent attempts
        // retain one first notification, even when their eventTime differs.
        const duplicate = yield* Ref.modify(receipts, (current) => {
          const previous = current.get(notification.eventId);
          const next = new Map(current);
          next.set(
            notification.eventId,
            previous === undefined
              ? { duplicates: 0, idempotencyKey: key, notification: body }
              : { ...previous, duplicates: previous.duplicates + 1 }
          );

          return [previous !== undefined, next];
        });

        yield* Effect.logInfo({
          duplicate,
          eventId: notification.eventId,
          eventType: notification.eventType,
          status: notification.event.troubleTicket.status ?? null,
          ticketId: notification.event.troubleTicket.id,
        });

        return HttpServerResponse.jsonUnsafe(
          { duplicate, eventId: notification.eventId },
          { status: 202 }
        );
      }).pipe(
        Effect.catchTag(["SchemaError", "HttpServerError"], () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              {
                error:
                  "Expected a TMF621 ticket notification with eventId, eventType, @type and event.troubleTicket.id.",
              },
              { status: 400 }
            )
          )
        )
      )
    );

    return HttpServer.formatAddress(server.address);
  }
);
