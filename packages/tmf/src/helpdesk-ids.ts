/**
 * Stable IDs of the helpdesk set v3 (`examples/helpdesk/v3`, decision
 * 0034) that the TMF621 mapping names (Contracts 11.1: a mapping names
 * fields by the stable IDs of the shipped sets, so renames never break
 * it). A test checks every ID against the set files.
 */

/** The helpdesk classes. */
export const HELPDESK_CLASS_IDS = {
  incident: "91446a86-8028-4d34-a501-b7cf0f59fdd5",
  note: "cb4f1713-bdad-5626-aff5-5a82fb3aa702",
  party: "c1360711-fa57-588f-b9a8-b30aa08ad16a",
  problem: "947a61be-ca35-5f45-b399-7d77352376c1",
  specification: "933b3f3a-8821-567e-bf73-ce175bf9cc6e",
  ticket: "be6a4618-76ea-4889-9f00-dd02c6099367",
} as const;

/** Fields of `helpdesk.ticket`. */
export const TICKET_FIELD_IDS = {
  assignedTo: "fc99eecb-5682-4a6c-8391-60d1055c4b2e",
  attachment: "0eb00997-cd53-5caf-b203-c44be2ca9064",
  caller: "d5526cf1-0545-5cb4-b8b3-f0bd776e4878",
  channel: "c0d4a5c2-afe9-5c7b-8de7-c28ff2776f04",
  characteristic: "2bfce88f-0386-55a7-82f3-fa2998984e6f",
  description: "88514acc-6b0d-4772-8604-43fe9a913446",
  expectedResolutionAt: "75ad37bf-572a-5536-abad-ad0d0a1458d8",
  externalIdentifier: "65f77455-5ee5-51c8-9687-da975f32ba6b",
  holdReason: "2eb33b17-491c-568d-ba0e-67e1192f5bab",
  impact: "c6b07207-c0b9-5c71-8ee1-1ef790ba9f8a",
  number: "6486c5d6-ff21-4f84-a454-b01c20048919",
  priority: "222508c2-9257-41db-a243-151441078982",
  priorityLabel: "af216ccf-12c8-5ea8-b976-6045d47ea43a",
  relatedEntity: "31693db8-c44d-51f5-b54b-b89e57560b89",
  requestedResolutionAt: "74314ad3-860e-5091-a059-4a30023dd175",
  resolutionCode: "b93e6de9-38f4-5ac9-b2f5-207586073d98",
  resolutionNotes: "2ca8a806-2830-4dad-8075-07f32257cca4",
  resolvedAt: "e387a9f3-886a-5e91-8823-34a180d8cddf",
  severityLabel: "8669c4c8-92da-5f4c-b4bb-eb6b139e10ed",
  shortDescription: "45e8b4dc-7041-4556-af31-1c802d537b8a",
  specification: "1fd792e2-8506-5c33-83fb-0149b4fdfa41",
  status: "4f51d80d-0886-4184-a8bb-5b5f7eefa4d2",
  statusChangeHistory: "edc0a81d-706d-5979-9835-429b9b050275",
  statusChangedAt: "2e054ec0-656d-5246-9c67-8bbef55f774e",
  statusReason: "c5bc8d9f-983a-5659-a570-f8a5c0e8d485",
  ticketRelationship: "7066fee3-5454-56cc-9b1e-73e684564a90",
  ticketType: "a00ca65a-c756-55b8-a5d9-1e49ccd3ba05",
  urgency: "dd40cba4-7f5c-5bb9-bb52-571bc8db8cc4",
} as const;

/** Fields of `helpdesk.incident`. */
export const INCIDENT_FIELD_IDS = {
  category: "e72b19cc-c9a8-44fe-9535-93f5b66e6637",
  majorIncident: "6b1bd403-01ff-57a5-8746-990c9050fc0c",
  parentIncident: "57816def-a484-5c9e-b314-2c37053327b3",
  problem: "9ab746a9-2006-53ab-91d8-ab351c2798af",
} as const;

/** Fields of `helpdesk.problem`. */
export const PROBLEM_FIELD_IDS = {
  knownError: "b37db3c0-e16e-5d19-afeb-1bf972e75307",
  rootCause: "1f2fb602-80ab-5fa4-841d-f755778ec39c",
  workaround: "5f67cb65-c784-5938-a191-c3dc98320e97",
} as const;

/** Fields of `helpdesk.ticket_note`. */
export const NOTE_FIELD_IDS = {
  author: "9b1a0ff8-dce6-523d-b230-4aab99f3cfe4",
  text: "2521a144-8f2a-5b21-9d1d-45692ea8a104",
  ticket: "bffb1c62-75e3-52c8-a297-d03dc463e587",
} as const;

/** Fields of `helpdesk.ticket_party`. */
export const PARTY_LINK_FIELD_IDS = {
  party: "653d4c03-ea1c-5f06-89a3-aff900250171",
  role: "eba4e422-fa81-5238-ab76-e7a57223a6ac",
  ticket: "386f5415-7aa1-5cfe-b4d1-43a50a2638ca",
} as const;

/** Fields of `helpdesk.ticket_specification`. */
export const SPECIFICATION_FIELD_IDS = {
  attachment: "0d8a21f8-9403-5f14-9b50-9c1e78382ced",
  characteristicSpecification: "d599d478-885b-5891-a76a-a3b4f98231d2",
  description: "467bfa6b-2e4d-570f-8383-8076aa196f3c",
  lifecycleStatus: "da645d4a-f946-592f-b3e0-8047fe85d3f0",
  name: "b678aa46-66b1-50c6-bd3e-2056ba568446",
  relatedParty: "1678612b-e91b-5ea0-ab49-4c8b1cd68a3e",
  version: "f8da24c3-3d8d-5012-ab3a-98d15669892a",
} as const;
