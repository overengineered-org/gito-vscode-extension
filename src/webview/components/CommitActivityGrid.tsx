import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  buildCalendarMonthLabels,
  buildCalendarDays,
  dateKeyFromDate,
  formatDateLabel,
  shiftDate,
  shiftMonth,
} from "../state/commitActivity.js";
import {
  formatCommitCount,
  type CommitActivityDay,
} from "./repositoryHomeTypes.js";

export function CommitActivityGrid({
  commitActivity,
  totalCommitCount,
  safetyCapReached,
  outputTruncated,
  isLoading,
  hasSelectedRepository,
  errorMessage,
}: {
  readonly commitActivity: readonly CommitActivityDay[];
  readonly totalCommitCount: number;
  readonly safetyCapReached: boolean;
  readonly outputTruncated: boolean;
  readonly isLoading: boolean;
  readonly hasSelectedRepository: boolean;
  readonly errorMessage?: string;
}) {
  const calendarDays = useMemo(
    () => buildCalendarDays(commitActivity),
    [commitActivity],
  );
  const inWindowDays = calendarDays.filter(
    (calendarDay) => calendarDay.isInWindow,
  );
  const currentDateKey = dateKeyFromDate(new Date());
  const [focusedDateKey, setFocusedDateKey] = useState(currentDateKey);
  const dayButtonReferences = useRef<Record<string, HTMLButtonElement | null>>(
    {},
  );

  useEffect(() => {
    if (
      inWindowDays.some((calendarDay) => calendarDay.dateKey === focusedDateKey)
    )
      return;
    setFocusedDateKey(
      inWindowDays[inWindowDays.length - 1]?.dateKey ?? currentDateKey,
    );
  }, [calendarDays, currentDateKey, focusedDateKey, inWindowDays]);

  const activitySummary = isLoading
    ? "Loading commit activity…"
    : errorMessage !== undefined
      ? "Commit activity unavailable."
      : !hasSelectedRepository
        ? "Select a repository."
        : outputTruncated
          ? "Commit activity is incomplete."
          : safetyCapReached
            ? "250,000+ commits found."
            : `${formatCommitCount(totalCommitCount)} commits in the last year.`;

  const moveFocusToDate = useCallback(
    (date: Date) => {
      const nextDateKey = dateKeyFromDate(date);
      if (
        !inWindowDays.some((calendarDay) => calendarDay.dateKey === nextDateKey)
      )
        return;
      setFocusedDateKey(nextDateKey);
      dayButtonReferences.current[nextDateKey]?.focus();
    },
    [inWindowDays],
  );

  const handleDayKeyDown = useCallback(
    (keyboardEvent: KeyboardEvent, date: Date) => {
      let targetDate: Date | undefined;
      if (keyboardEvent.key === "ArrowLeft") targetDate = shiftDate(date, -1);
      if (keyboardEvent.key === "ArrowRight") targetDate = shiftDate(date, 1);
      if (keyboardEvent.key === "ArrowUp") targetDate = shiftDate(date, -7);
      if (keyboardEvent.key === "ArrowDown") targetDate = shiftDate(date, 7);
      if (keyboardEvent.key === "Home")
        targetDate = shiftDate(date, -((date.getDay() + 6) % 7));
      if (keyboardEvent.key === "End")
        targetDate = shiftDate(date, 6 - ((date.getDay() + 6) % 7));
      if (keyboardEvent.key === "PageUp") targetDate = shiftMonth(date, -1);
      if (keyboardEvent.key === "PageDown") targetDate = shiftMonth(date, 1);
      if (targetDate === undefined) return;
      keyboardEvent.preventDefault();
      moveFocusToDate(targetDate);
    },
    [moveFocusToDate],
  );

  const monthLabels = buildCalendarMonthLabels(calendarDays);
  const calendarColumnCount = Math.ceil(calendarDays.length / 7);

  const isInteractiveHeatmap =
    !isLoading && errorMessage === undefined && hasSelectedRepository;

  return (
    <section class="commit-card" aria-labelledby="commit-activity-heading">
      <div class="commit-summary">
        <h2 id="commit-activity-heading">Commit activity</h2>
        <p
          class="commit-summary-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {activitySummary}
        </p>
        {errorMessage !== undefined ? (
          <p class="commit-error">{errorMessage}</p>
        ) : null}
        {!isLoading &&
        errorMessage === undefined &&
        hasSelectedRepository &&
        commitActivity.length === 0 ? (
          <p class="commit-empty-note">
            No matching commits for the configured author emails.
          </p>
        ) : null}
        {outputTruncated ? (
          <p class="commit-cap-note">
            Activity is incomplete because Git output reached the safety limit.
          </p>
        ) : safetyCapReached ? (
          <p class="commit-cap-note">
            Activity stops at the 250,000 matching commit safety cap.
          </p>
        ) : null}
      </div>
      <div
        class="heatmap-scroll-region"
        aria-busy={isLoading ? "true" : undefined}
      >
        {isInteractiveHeatmap ? (
          <>
            <div class="heatmap-weekday-labels" aria-hidden="true">
              <span style={{ gridRow: 1 }}>Mon</span>
              <span style={{ gridRow: 3 }}>Wed</span>
              <span style={{ gridRow: 5 }}>Fri</span>
            </div>
            <div class="heatmap-scroll-content">
              <div
                class="heatmap-month-labels"
                aria-hidden="true"
                style={{
                  gridTemplateColumns: `repeat(${calendarColumnCount}, 24px)`,
                }}
              >
                {monthLabels.map((monthLabel) => (
                  <span
                    key={monthLabel.dateKey}
                    style={{ gridColumnStart: monthLabel.columnIndex }}
                  >
                    {monthLabel.label}
                  </span>
                ))}
              </div>
              <div
                class="heatmap-grid"
                style={{
                  gridTemplateColumns: `repeat(${calendarColumnCount}, 24px)`,
                }}
                role="grid"
                aria-label="Commit activity for the last 365 days"
                aria-rowcount={7}
                aria-colcount={calendarColumnCount}
                aria-describedby="commit-activity-keyboard-help"
              >
                {Array.from({ length: 7 }, (_, rowIndex) => (
                  <div
                    class="heatmap-grid-row"
                    role="row"
                    aria-rowindex={rowIndex + 1}
                    key={rowIndex}
                  >
                    {calendarDays
                      .filter(
                        (_, calendarIndex) => calendarIndex % 7 === rowIndex,
                      )
                      .map((calendarDay, columnIndex) => {
                        const dateLabel = formatDateLabel(calendarDay.date);
                        const commitCountLabel = `${formatCommitCount(calendarDay.commitCount)} ${calendarDay.commitCount === 1 ? "commit" : "commits"}`;
                        return (
                          <div
                            class={`heatmap-cell-wrapper${calendarDay.isInWindow ? "" : " is-outside-window"}`}
                            role="gridcell"
                            aria-colindex={columnIndex + 1}
                            key={calendarDay.dateKey}
                          >
                            {calendarDay.isInWindow ? (
                              <button
                                type="button"
                                class={`heatmap-cell heatmap-cell--${Math.min(4, Math.ceil(calendarDay.commitCount / 3))}`}
                                aria-label={`${dateLabel}: ${commitCountLabel}`}
                                title={`${dateLabel}: ${commitCountLabel}`}
                                tabIndex={
                                  focusedDateKey === calendarDay.dateKey
                                    ? 0
                                    : -1
                                }
                                ref={(dayButton) => {
                                  dayButtonReferences.current[
                                    calendarDay.dateKey
                                  ] = dayButton;
                                }}
                                onFocus={() =>
                                  setFocusedDateKey(calendarDay.dateKey)
                                }
                                onKeyDown={(keyboardEvent) =>
                                  handleDayKeyDown(
                                    keyboardEvent,
                                    calendarDay.date,
                                  )
                                }
                              />
                            ) : null}
                          </div>
                        );
                      })}
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div class="heatmap-placeholder" aria-hidden="true">
            {isLoading
              ? "Loading…"
              : errorMessage !== undefined
                ? "Commit activity unavailable"
                : "Select a repository"}
          </div>
        )}
      </div>
      <fieldset class="heatmap-legend" role="group">
        <legend>Commit activity level</legend>
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((activityLevel) => (
          <span
            class={`heatmap-legend-swatch heatmap-cell--${activityLevel}`}
            aria-hidden="true"
            key={activityLevel}
          />
        ))}
        <span>More</span>
      </fieldset>
      <p class="sr-only" id="commit-activity-keyboard-help">
        Use arrow keys to move by day. Home and End move within the week. Page
        Up and Page Down move by month.
      </p>
    </section>
  );
}
