/**
 * STD's layout of the Foldkit UI Date Picker: a labelled trigger that
 * shows the picked date as `YYYY-MM-DD`, and the calendar's days, months
 * and years grids. The Date Picker supplies the popover, focus handling,
 * keyboard navigation and ARIA; `styles.css` styles its `data-*` states.
 */
import { DatePicker } from "@foldkit/ui";
import type { Calendar } from "@foldkit/ui";
import type { AnchorConfig } from "@foldkit/ui/popover";
import { formatCivilDate } from "@std/values/calendar";
import { Match, Option } from "effect";
import type { CalendarDate } from "foldkit/calendar";
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html";

const ANCHOR: AnchorConfig = { gap: 4, padding: 8, placement: "bottom-start" };

const CALENDAR_CLASS = "calendar";

const HEADER_CLASS = "calendar-header";

const HEADING_CLASS = "calendar-heading";

const ROW_CLASS = "calendar-row";

const CELL_CLASS = "calendar-cell";

const DAY_CLASS = "calendar-day";

const PICKS_CLASS = "calendar-picks";

const navButton = <Message>(
  attributes: readonly ChildAttribute[],
  text: string,
  h: HtmlBuilder<Message>
): Html => h.button([...attributes, h.Class("calendar-nav")], [text]);

const headingButton = <Message>(
  heading: Calendar.DaysModeAttributes["heading"],
  attributes: readonly ChildAttribute[],
  h: HtmlBuilder<Message>
): Html =>
  h.button(
    [h.Id(heading.id), ...attributes, h.Class(HEADING_CLASS)],
    [heading.text]
  );

const daysView = <Message>(
  days: Calendar.DaysModeAttributes,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [...days.root, h.Class(CALENDAR_CLASS)],
    [
      h.div(
        [h.Class(HEADER_CLASS)],
        [
          navButton(days.previousMonthButton, "‹", h),
          headingButton(days.heading, days.headingButton, h),
          navButton(days.nextMonthButton, "›", h),
        ]
      ),
      h.div(
        [...days.grid, h.Class("calendar-grid")],
        [
          h.div(
            [...days.headerRow, h.Class(ROW_CLASS)],
            days.columnHeaders.map((header) =>
              h.div(
                [...header.attributes, h.Class("calendar-column-header")],
                [header.name]
              )
            )
          ),
          ...days.weeks.map((week) =>
            h.div(
              [...week.attributes, h.Class(ROW_CLASS)],
              week.cells.map((cell) =>
                h.div(
                  [...cell.cellAttributes, h.Class(CELL_CLASS)],
                  [
                    h.button(
                      [...cell.buttonAttributes, h.Class(DAY_CLASS)],
                      [cell.label]
                    ),
                  ]
                )
              )
            )
          ),
        ]
      ),
    ]
  );

const monthsView = <Message>(
  months: Calendar.MonthsModeAttributes,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [...months.root, h.Class(CALENDAR_CLASS)],
    [
      h.div(
        [h.Class(HEADER_CLASS)],
        [headingButton(months.heading, months.headingButton, h)]
      ),
      h.div(
        [...months.grid, h.Class(PICKS_CLASS)],
        months.cells.map((cell) =>
          h.div(
            [...cell.cellAttributes, h.Class(CELL_CLASS)],
            [
              h.button(
                [...cell.buttonAttributes, h.Class(DAY_CLASS)],
                [cell.shortLabel]
              ),
            ]
          )
        )
      ),
    ]
  );

const yearsView = <Message>(
  years: Calendar.YearsModeAttributes,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [...years.root, h.Class(CALENDAR_CLASS)],
    [
      h.div(
        [h.Class(HEADER_CLASS)],
        [
          navButton(years.previousPageButton, "‹", h),
          h.h2(
            [h.Id(years.heading.id), h.Class(HEADING_CLASS)],
            [years.heading.text]
          ),
          navButton(years.nextPageButton, "›", h),
        ]
      ),
      h.div(
        [...years.grid, h.Class(PICKS_CLASS)],
        years.cells.map((cell) =>
          h.div(
            [...cell.cellAttributes, h.Class(CELL_CLASS)],
            [
              h.button(
                [...cell.buttonAttributes, h.Class(DAY_CLASS)],
                [cell.label]
              ),
            ]
          )
        )
      ),
    ]
  );

/** A labelled Date Picker. */
export interface DatePickerFieldConfig<Message> {
  readonly label: string;
  readonly model: DatePicker.Model;
  readonly maybeSelectedDate: Option.Option<CalendarDate>;
  readonly toParentMessage: (message: DatePicker.Message) => Message;
  /**
   * More attributes of the trigger, such as `aria-describedby` naming a
   * field's problems and `aria-invalid`.
   */
  readonly triggerAttributes?: readonly ChildAttribute[];
}

/**
 * A labelled Date Picker.
 *
 * @param config - Its label, Model, picked date and Message wrapper.
 * @param h - The builder.
 * @returns The control.
 */
export const datePickerField = <Message>(
  config: DatePickerFieldConfig<Message>,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [h.Class("control")],
    [
      h.label(
        [
          h.For(DatePicker.triggerId(config.model.id)),
          h.Class("control-label"),
        ],
        [config.label]
      ),
      h.submodel({
        model: config.model,
        slotId: config.model.id,
        toParentMessage: config.toParentMessage,
        view: DatePicker.view,
        viewInputs: {
          anchor: ANCHOR,
          backdropClassName: "date-picker-backdrop",
          className: "date-picker",
          maybeSelectedDate: config.maybeSelectedDate,
          panelClassName: "date-picker-panel",
          toCalendarView: (attributes: Calendar.CalendarAttributes) =>
            Match.value(attributes).pipe(
              Match.tag("Days", (days) => daysView(days, h)),
              Match.tag("Months", (months) => monthsView(months, h)),
              Match.tag("Years", (years) => yearsView(years, h)),
              Match.exhaustive
            ),
          triggerAttributes: config.triggerAttributes ?? [],
          triggerClassName: "control-input date-picker-trigger",
          triggerContent: (maybeDate) =>
            h.span(
              [h.Class("date-picker-value")],
              [
                Option.match(maybeDate, {
                  onNone: () => "Pick a date",
                  onSome: formatCivilDate,
                }),
              ]
            ),
        },
      }),
    ]
  );
