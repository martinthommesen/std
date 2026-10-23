import type { DeadDelivery } from "@std/api/dead-letters";

import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import { init, update } from "./update.ts";

/** A disposable fixture delivery, containing identities and sanitized diagnostics only. */
export const delivery: typeof DeadDelivery.Type = {
  "@type": "DeadDelivery",
  attempts: 10,
  changeId: "019a0000-0000-7000-8000-000000000001",
  deadLetterPolicy: "block",
  finishedAt: "2026-10-23T10:00:00Z",
  href: "http://std.test/api/v1/deadDelivery/7",
  id: "7",
  lastError: "DeliveryFailed: listener refused",
  recordId: "019a0000-0000-7000-8000-000000000002",
  recordVersion: 2,
  status: "dead",
  subscriptionId: "019a0000-0000-7000-8000-000000000003",
  subscriptionState: "served",
};

/** The server's first page, ready for operator actions. */
export const loaded = update(
  init(1).model,
  Message.SucceededLoadDeadLetters({
    page: { deliveries: [delivery], total: 1 },
    requestId: 1,
  })
).model;

/** A completed read of an empty operator page.
 * @param requestId - The request being answered.
 * @returns The successful empty-page reply.
 */
export const emptyPage = (requestId: number) =>
  Message.SucceededLoadDeadLetters({
    page: { deliveries: [], total: 0 },
    requestId,
  });

/** A confirmed task awaiting the server's answer.
 * @param action - The operation chosen for the fixture delivery.
 * @returns The executing operator page.
 */
export const executing = (action: "retry" | "discard"): Model =>
  update(
    update(loaded, Message.ClickedAction({ action, delivery })).model,
    Message.ClickedConfirm()
  ).model;
