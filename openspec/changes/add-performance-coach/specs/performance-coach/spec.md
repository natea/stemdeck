# Spec Delta

## Purpose
The performance coach compares a musician's recorded Performance take with the transcribed part it replaced, measures what was played well and badly bar by bar, and turns that into a report with plain tips that is kept over time.

## ADDED Requirements

### Requirement: A take knows which part was played
When a Performance take is finished, the system SHALL record on the take which stem the musician chose with I play at that moment. The user SHALL be able to set or change a take's part afterwards, choosing from the song's stems. A take with no part SHALL NOT be offered for coaching until a part is set.

#### Scenario: Recording with I play
- **WHEN** the musician has chosen Bass under I play and finishes a take
- **THEN** the take's part is Bass

#### Scenario: An older take
- **WHEN** a take recorded without a part is opened for review
- **THEN** the Coach action asks which part was played, and once one is chosen the take can be coached

### Requirement: The coach needs a reference
The Coach action SHALL be offered only when the take's part has a transcription and the song has a beat grid. When the part has no transcription, the system SHALL say so and offer to transcribe that stem first. Where transcription is unavailable on the machine, the Coach action SHALL NOT be shown.

#### Scenario: Part not transcribed yet
- **WHEN** the musician asks to coach a guitar take and the guitar stem has no transcription
- **THEN** the system says the guitar part must be transcribed first and offers Transcribe for that stem

### Requirement: Coaching runs locally and can be cancelled
Coaching SHALL run on the machine that runs StemDeck, SHALL NOT send the take's audio or video anywhere, SHALL show progress while it runs, and SHALL be cancellable. A cancelled or failed run SHALL leave earlier reports untouched.

#### Scenario: Cancel
- **WHEN** the musician cancels a coach run halfway
- **THEN** no new report is saved and the take's earlier reports are unchanged

### Requirement: Measurements per bar
For each bar the take covers, the report SHALL give: the number of reference notes, how many were played, missed and added, how many were played at the wrong pitch, the median timing offset from the reference in milliseconds (negative early, positive late), the spread of the timing offsets, and the loudness relative to the reference. For a drums part, pitch measurements SHALL be omitted and notes SHALL be matched by onset and drum kind. Bars outside the take's span SHALL NOT be scored.

#### Scenario: Rushing a bar
- **WHEN** the musician plays every note of bar 20 about 40 ms before the reference
- **THEN** bar 20 shows all notes played and a median timing offset of about -40 ms

#### Scenario: A wrong note
- **WHEN** the musician plays an F where the reference has an E in bar 8
- **THEN** bar 8 counts one wrong pitch and the note is not counted as missed

#### Scenario: A short take
- **WHEN** the take covers bars 30 to 45 only
- **THEN** the report scores bars 30 to 45 and no others

### Requirement: Alignment tolerates a loose start and drift
Before measuring, the system SHALL line the take up with the reference so that a consistent offset (a late start, or the recording latency the musician did not nudge away) and a slow steady drift are not reported as errors in every bar. The report SHALL state the overall offset it removed.

#### Scenario: Consistent latency
- **WHEN** every note of a take is 25 ms late because of an uncorrected recording latency
- **THEN** the report states a 25 ms overall offset and the bars show timing offsets near zero

### Requirement: Too little to judge
When a take is shorter than two bars, or is so quiet or so different from the reference that fewer than a quarter of the reference notes can be matched, the system SHALL NOT produce scores and SHALL say why, suggesting the likely cause (wrong part chosen, input level too low, or the take is too short).

#### Scenario: Wrong part chosen
- **WHEN** a bass take is coached as Piano and almost nothing matches
- **THEN** the report says the take does not match the Piano part and asks whether the part is right

### Requirement: The report has a summary and tips
Each report SHALL include an overall summary (share of notes played, share at the right pitch, median timing offset and its spread), the bars or sections that most need work, and between one and five tips. Every tip SHALL name the bars or section it is about and the measurement it rests on, and SHALL use musical words (rushing, dragging, missed notes, dynamics) rather than model or signal terms.

#### Scenario: A tip
- **WHEN** bars 33 to 36 are all early by 35 to 50 ms and the rest of the take is within 15 ms
- **THEN** one tip says the musician rushes bars 33 to 36 by about 40 ms

### Requirement: The report in the review
The take review in Performance mode SHALL show the report as a strip of bars along the take timeline, each bar marked by how well it went, with the summary and tips beside it. Clicking a bar SHALL move the song and the take to the start of that bar. Clicking a tip SHALL do the same for the first bar it names.

#### Scenario: Jump to a bar
- **WHEN** the musician clicks bar 33 in the strip
- **THEN** the song and the take both move to the start of bar 33

### Requirement: Reports are kept and compared
The system SHALL keep every report of a take, with the time it was made, and SHALL keep reports when a take is renamed or nudged. For a song, the system SHALL show how the overall summary of its coached takes has changed over time, per part. Deleting a take SHALL delete its reports.

#### Scenario: Progress
- **WHEN** a song has three coached bass takes from different days
- **THEN** the song shows the three summaries in date order, so the musician can see whether timing and accuracy improved

### Requirement: The report can be read by other tools
The system SHALL serve a take's reports, and a song's report history, from its local API in a documented JSON form, so that a coaching assistant can read them. The served report SHALL contain measurements and text only, never the take's audio or video. A correction to a finding (for example, a bar marked as intentionally different) SHALL be accepted through the same API, kept with the report, and shown in the review.

#### Scenario: A correction
- **WHEN** an assistant records that bar 12's missing notes were palm-muted on purpose
- **THEN** the report keeps bar 12's measurements, marks bar 12 as intentional, and the review shows that note
