/**
 * The payloads `pnpm ctk:ci` gives the TMF621 Conformance Test Kit: real
 * values for the fields the kit's defaults fill with `sample_*`
 * placeholders. The keys are the kit configuration's (`TroubleTicket`,
 * `TroubleTicketSpecification`), each with a POST and a PATCH `payload`.
 * `Hub` is left out, so the kit keeps its default.
 */

/** A TroubleTicket the helpdesk set v3 accepts. */
export const TROUBLE_TICKET = {
  "@type": "TroubleTicket",
  description: "CTK conformance ticket",
  name: "CTK ticket",
  severity: "Major",
  ticketType: "incident",
} as const;

/** A TroubleTicketSpecification the helpdesk set v3 accepts. */
export const TROUBLE_TICKET_SPECIFICATION = {
  "@type": "TroubleTicketSpecification",
  name: "CTK specification",
} as const;

/** The kit configuration's `payloads` override. */
export const CTK_PAYLOADS = {
  TroubleTicket: {
    PATCH: { payload: TROUBLE_TICKET },
    POST: { payload: TROUBLE_TICKET },
  },
  TroubleTicketSpecification: {
    PATCH: { payload: TROUBLE_TICKET_SPECIFICATION },
    POST: { payload: TROUBLE_TICKET_SPECIFICATION },
  },
} as const;

/** A payload the kit sends. */
export type CtkPayload =
  | typeof TROUBLE_TICKET
  | typeof TROUBLE_TICKET_SPECIFICATION;
