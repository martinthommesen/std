/**
 * The response recorder of the leak checks (`captureResponses`; decision
 * 0020, "CI: deterministic response capture"): a request cancelled while
 * its response is paused delivers no body, so the checks neither wait for
 * it nor count it as an unread body, and later checks settle.
 *
 * A page and a slow answer from a server of the test's own, in a real
 * browser; no `std serve`.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";

import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Option, Predicate, Schedule } from "effect";

import { captureResponses, pausedResponseUrls } from "./app.ts";
import { launchBrowser } from "./support.ts";

/** The slow answer's whole body; the server sends only its first part. */
const SLOW_BODY = "abcdefg";

const SENT_PART = SLOW_BODY.slice(0, 4);

/** The page: it fetches the slow answer and can cancel it. */
const PAGE = `<!doctype html><html><body><p>capture</p><script>
  const controller = new AbortController();
  window.startSlow = () => {
    fetch("/slow", { signal: controller.signal }).then(
      (response) => response.text(),
    ).catch(() => "cancelled");
  };
  window.cancelSlow = () => controller.abort();
</script></body></html>`;

/** How long a check may take before it counts as hanging. */
const CHECK_LIMIT = "5 seconds";

/**
 * The test's server: `/` the page, `/slow` 4 of 7 bytes and then nothing,
 * `/ok` a short text. Closed with the scope.
 *
 * @param slowSent - Completed once `/slow` has sent its first part.
 * @returns Its origin.
 */
const slowServer = (slowSent: Deferred.Deferred<boolean>) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer((request, response) => {
        if (request.url === "/slow") {
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-length": String(SLOW_BODY.length),
            "content-type": "text/plain",
          });
          response.write(SENT_PART, () => {
            Deferred.doneUnsafe(slowSent, Effect.succeed(true));
          });

          return;
        }

        const isPage = request.url === "/";

        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": isPage ? "text/html" : "text/plain",
        });
        response.end(isPage ? PAGE : "fine");
      });

      server.listen(0, "127.0.0.1", () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.callback<Server>((resume) => {
        server.close(() => {
          resume(Effect.succeed(server));
        });
        server.closeAllConnections();
      })
  ).pipe(
    Effect.map((server) => {
      const address = server.address();

      const port =
        Predicate.hasProperty(address, "port") &&
        Predicate.isNumber(address.port)
          ? address.port
          : 0;

      return `http://127.0.0.1:${port}`;
    })
  );

/**
 * A page of its own browser, its responses recorded, whose fetch of the
 * slow answer the recorder holds paused, reading the body the server
 * never finishes.
 */
const pausedSlowAnswer = Effect.gen(function* slowAnswerPaused() {
  const slowSent = yield* Deferred.make<boolean>();
  const origin = yield* slowServer(slowSent);
  const browser = yield* launchBrowser;

  const page = yield* Effect.promise(async () => {
    const context = await browser.newContext();

    return await context.newPage();
  });

  const responses = yield* Effect.promise(
    async () => await captureResponses(page)
  );

  yield* Effect.promise(async () => {
    await page.goto(`${origin}/`);
    await page.evaluate("window.startSlow()");
  });
  yield* Deferred.await(slowSent);

  yield* Effect.promise(async () => await pausedResponseUrls(page)).pipe(
    Effect.filterOrFail((urls) => urls.includes(`${origin}/slow`)),
    Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 250 }),
    Effect.orDie
  );

  return { origin, page, responses };
});

describe("the response recorder", () => {
  it("cancels the slow answer partway through its body", () => {
    assert.isAbove(SENT_PART.length, 0);
    assert.isBelow(SENT_PART.length, SLOW_BODY.length);
  });

  // NOTE: live, not `it.effect`: the check's time limit runs on the real
  // clock.
  it.live(
    "a request cancelled while its response is paused delivers no body: checks neither wait for it nor fail on it",
    () =>
      Effect.gen(function* cancelledTest() {
        const { origin, page, responses } = yield* pausedSlowAnswer;

        yield* Effect.promise(async () => {
          await page.evaluate("window.cancelSlow()");
        });

        const afterCancel = yield* Effect.promise(
          async () => await responses()
        ).pipe(Effect.timeoutOption(CHECK_LIMIT));

        assert.isTrue(
          Option.isSome(afterCancel),
          "the check after the cancellation settles"
        );

        const urls = Option.getOrElse(afterCancel, () => []).map(
          (response) => response.url
        );

        assert.include(urls, `${origin}/`);
        assert.notInclude(urls, `${origin}/slow`);

        // A later answer is held and checked as usual.
        yield* Effect.promise(async () => {
          await page.evaluate(
            "fetch('/ok').then((response) => response.text())"
          );
        });

        const later = yield* Effect.promise(async () => await responses()).pipe(
          Effect.timeoutOption(CHECK_LIMIT)
        );

        assert.deepInclude(
          Option.getOrElse(later, () => []),
          {
            body: "fine",
            url: `${origin}/ok`,
          }
        );
      }).pipe(Effect.scoped)
  );

  it.live(
    "closing the page releases a read still paused: the check settles",
    () =>
      Effect.gen(function* closedTest() {
        const { origin, page, responses } = yield* pausedSlowAnswer;

        yield* Effect.promise(async () => {
          await page.close();
        });

        const afterClose = yield* Effect.promise(
          async () => await responses()
        ).pipe(Effect.timeoutOption(CHECK_LIMIT));

        assert.isTrue(
          Option.isSome(afterClose),
          "the check after the page closed settles"
        );
        assert.notInclude(
          Option.getOrElse(afterClose, () => []).map(
            (response) => response.url
          ),
          `${origin}/slow`
        );
      }).pipe(Effect.scoped)
  );
});
