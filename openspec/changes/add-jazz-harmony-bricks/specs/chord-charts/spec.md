# Spec Delta

## Purpose

Lets a user attach the chord changes for one chorus of a song, lines them up with the song's bars and with each chorus in the recording, and keeps them with the song so every harmony feature has something to read.

## ADDED Requirements

### Requirement: A song can carry one chord chart
The system SHALL let a user add, replace and remove a chord chart on any finished song. A chart SHALL describe one chorus of the song as an ordered list of bars, each holding one or more chords, optionally grouped into labelled sections. The chart SHALL be stored with the song and returned unchanged on the next read.

#### Scenario: Save and reload a chart
- **WHEN** a user saves a 16-bar chart on a finished song and reopens the song
- **THEN** the same 16 bars, chords and section labels are shown

#### Scenario: Remove a chart
- **WHEN** a user removes the chart from a song
- **THEN** the song has no chart and every harmony view for that song shows its empty state

#### Scenario: Song is not finished
- **WHEN** a chart is saved for a song that is still importing or has failed
- **THEN** the system refuses the request and stores nothing

### Requirement: Charts are entered as plain text
The system SHALL accept a chart typed or pasted as text in which bars are separated by `|`, chords inside a bar are separated by spaces, `%` repeats the previous bar, and a label in square brackets starts a section. Chords sharing a bar SHALL split the bar evenly unless the user sets the beats for each.

#### Scenario: Paste a chart
- **WHEN** a user pastes `[A] | C- | % | F- | % | Dø | G7+9 | C-Δ | % |`
- **THEN** the chart has one section labelled A with eight bars, and bars 2, 4 and 8 repeat the chord before them

#### Scenario: Two chords in a bar
- **WHEN** a bar is entered as `D- G7` in a song in four time
- **THEN** each chord lasts two beats

#### Scenario: Unreadable text
- **WHEN** the pasted text contains a chord the system cannot read
- **THEN** nothing is saved and the system names the bar and the text it could not read

### Requirement: Common chord spellings are understood
The system SHALL read the common spellings of each chord type and treat them as the same chord: major (such as `C`, `C6`, `Cmaj7`, `CM7`, `CΔ`), minor seventh (`Cm7`, `C-`, `Cmi7`), dominant (`C7`, `C9`, `C13`, `C7#9`, `C7alt`), half-diminished (`Cø`, `Cm7b5`), diminished (`Co`, `Cdim7`), and minor with a major seventh or sixth (`CmΔ`, `Cm6`). It SHALL read a slash bass note and SHALL keep the chord text the user typed for display.

#### Scenario: Two spellings of one chord
- **WHEN** one chart writes a bar as `Dm7b5` and another writes it as `Dø`
- **THEN** both are treated as D half-diminished
- **AND** each chart still shows the spelling its user typed

#### Scenario: Slash chord
- **WHEN** a bar is entered as `F/A`
- **THEN** the chord is F major with A in the bass

### Requirement: A chart is placed on the recording
The system SHALL let the user mark the bar of the recording where the first chorus starts. From there the chart SHALL repeat chorus after chorus along the song's bar grid until the song ends, and the user SHALL be able to move the start of any later chorus and to mark where the choruses end.

#### Scenario: Chart repeats along the recording
- **WHEN** a 32-bar chart is placed with its first chorus at bar 9 of a 136-bar recording
- **THEN** choruses start at bars 9, 41, 73 and 105

#### Scenario: A chorus starts late
- **WHEN** the user moves the start of the third chorus two bars later
- **THEN** that chorus and every chorus after it start two bars later, and the earlier ones do not move

#### Scenario: Song has no bar grid
- **WHEN** a chart is saved on a song that has no bar grid
- **THEN** the chart is kept and shown, and the system says it cannot follow playback until the song has a bar grid

### Requirement: The app can tell which chord is sounding
For a placed chart, the system SHALL report, for any time in the recording, the chorus number, the section, the bar within the chorus and the chord at that time, or report that the time falls outside every chorus.

#### Scenario: Time inside a chorus
- **WHEN** the chord at a time in bar 3 of the second chorus is asked for
- **THEN** the answer names chorus 2, the section, bar 3 and that bar's chord

#### Scenario: Time in the intro
- **WHEN** the chord at a time before the first chorus is asked for
- **THEN** the answer is that no chorus is playing

### Requirement: Editing the bar grid does not lose the chart
The system SHALL keep a song's chart when its bar grid is edited or rebuilt, and SHALL keep each chorus start at the same moment in the recording.

#### Scenario: Bar grid shifted
- **WHEN** the user moves the first downbeat of a song that has a placed chart
- **THEN** the chart is still there and each chorus still starts at the same point in the music

### Requirement: All charts in the library can be read together
The system SHALL provide every stored chart in the library in a single read, each identified by its song, so library-wide features do not have to open songs one at a time.

#### Scenario: Library with some charts
- **WHEN** the library has 40 songs and 6 of them have charts
- **THEN** one read returns those 6 charts with their song identifiers and titles
