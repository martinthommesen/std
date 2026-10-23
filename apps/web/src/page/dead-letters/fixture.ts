import type { DeadDelivery } from "@std/api/dead-letters";

import { Message } from "./message.ts";
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
};

/** The server's first page, ready for operator actions. */
export const loaded = update(
  init(1).model,
  Message.SucceededLoadDeadLetters({
    page: { deliveries: [delivery], total: 1 },
    requestId: 1,
  })
).model;
