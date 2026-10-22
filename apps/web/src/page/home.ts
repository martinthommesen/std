import type { CurrentUser } from "@std/api/session";
import type { Html, HtmlBuilder } from "foldkit/html";

const HEADING_ID = "home-heading";

const TABLES_HEADING_ID = "home-tables-heading";

// NOTE: the list of tables needs the metadata endpoint (Step 2,
// workstream 2A), which no released endpoint replaces: the generic record
// routes cannot list the tables a caller may open. Until it lands this
// section is a placeholder (decision 0018).
const tablesView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("panel"), h.AriaLabelledBy(TABLES_HEADING_ID)],
    [
      h.h2([h.Id(TABLES_HEADING_ID)], ["Tables"]),
      h.p(
        [h.Class("placeholder")],
        ["The tables you can open will be listed here."]
      ),
    ]
  );

/**
 * The home page.
 *
 * @param user - Who is signed in.
 * @param h - The builder.
 * @returns The page.
 */
export const view = <Message>(
  user: CurrentUser,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [h.Class("page")],
    [h.h1([h.Id(HEADING_ID)], [`Welcome, ${user.name}`]), tablesView(h)]
  );
