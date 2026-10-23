import { assert, describe, it } from "@effect/vitest";

import { CTK_PAYLOADS } from "../src/ctk-payloads.ts";

describe("the CTK payloads", () => {
  it("hold no sample_* placeholder and name a TMF type", () => {
    const text = JSON.stringify(CTK_PAYLOADS);

    assert.notInclude(text, "sample_");
    assert.strictEqual(
      CTK_PAYLOADS.TroubleTicket.POST.payload["@type"],
      "TroubleTicket"
    );
    assert.strictEqual(
      CTK_PAYLOADS.TroubleTicketSpecification.POST.payload["@type"],
      "TroubleTicketSpecification"
    );
  });

  it("give every resource a POST and a PATCH payload and leave Hub out", () => {
    assert.deepStrictEqual(Object.keys(CTK_PAYLOADS).toSorted(), [
      "TroubleTicket",
      "TroubleTicketSpecification",
    ]);

    for (const resource of Object.values(CTK_PAYLOADS)) {
      assert.deepStrictEqual(Object.keys(resource).toSorted(), [
        "PATCH",
        "POST",
      ]);
    }
  });
});
