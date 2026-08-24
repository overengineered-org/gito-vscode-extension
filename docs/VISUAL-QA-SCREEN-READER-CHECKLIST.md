# Screen-reader evidence checklist

Complete each row with a real installed VSIX. Do not mark a row complete from
jsdom, axe output, or a Chromium accessibility tree alone.

| Theme               | Zoom | Screen reader and OS | Exact VSIX SHA | Transcript or recording | Reviewer/date |
| ------------------- | ---: | -------------------- | -------------- | ----------------------- | ------------- |
| Dark Modern         | 100% |                      |                |                         |               |
| Light Modern        | 100% |                      |                |                         |               |
| Dark High Contrast  | 100% |                      |                |                         |               |
| Light High Contrast | 100% |                      |                |                         |               |
| Git'o Visual QA     | 100% |                      |                |                         |               |
| Dark Modern         | 200% |                      |                |                         |               |

Confirm manually:

- Repository Home is announced as the main landmark.
- Heading order and names are understandable.
- Repository, provider, refresh, summary, pull-request, and health controls
  expose useful names and state.
- Commit activity instructions and live status announcements are spoken.
- Keyboard focus remains visible and returns to the triggering control after
  details close.
- No visual-only information is required to complete the dashboard flow.
