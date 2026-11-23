# Spec Delta

## Purpose

Turns the transcribed notes of a guitar or bass stem into tablature by choosing a string and fret for every note from a tuning and capo, so a player can read where to put their fingers.

## ADDED Requirements

### Requirement: Fretted stems can be shown as tablature
The system SHALL offer tablature for the `guitar` and `bass` stems. For each of those stems the user SHALL be able to choose tablature, staff notation, or both together. Other stems SHALL be shown as staff notation only.

#### Scenario: Bass as tab
- **WHEN** a user chooses tablature for the `bass` stem
- **THEN** the stem is drawn on a four-line tab staff with a fret number for every note

#### Scenario: Both
- **WHEN** a user chooses both for the `guitar` stem
- **THEN** a staff and a six-line tab staff are drawn together, bar for bar

#### Scenario: Piano has no tab choice
- **WHEN** a user looks at the options for the `piano` stem
- **THEN** no tablature choice is offered

### Requirement: Every tab note has a string and fret that sound its pitch
For each note of a fretted stem the system SHALL assign one string and one fret such that the open string's pitch, plus the capo, plus the fret, equals the note's pitch. Notes sounding at the same time SHALL be on different strings.

#### Scenario: Single note
- **WHEN** a guitar in standard tuning plays the E above middle C (MIDI 64)
- **THEN** the tab shows a string and fret that sound that pitch, such as the open first string

#### Scenario: Chord
- **WHEN** three notes start together
- **THEN** each is on a different string

### Requirement: Fingerings are playable
The system SHALL choose strings and frets a player can reach: notes sounding together SHALL fit within a hand span of frets (open strings excepted), and the hand position SHALL move as little as the music allows from one note to the next. Where two positions are equally reachable, the lower one SHALL be preferred.

#### Scenario: Stays in position
- **WHEN** a bass line moves stepwise within a fourth
- **THEN** the tab stays within a few frets, crossing strings instead of jumping along one

#### Scenario: Chord span
- **WHEN** a guitar chord is assigned
- **THEN** its fretted notes span no more than four frets

#### Scenario: Low position preferred
- **WHEN** a melody can be played equally well at the second fret or the fourteenth
- **THEN** the tab uses the second-fret position

### Requirement: Tuning and capo are chosen per stem
The user SHALL be able to choose the tuning and capo for each fretted stem of a song. Guitar SHALL default to standard six-string tuning (E A D G B E) and bass to standard four-string (E A D G), with no capo. The system SHALL offer common alternatives (at least drop D and half-step down for guitar, five-string and drop D for bass) and SHALL remember the choice for the song. Changing either SHALL change the tab without transcribing again.

#### Scenario: Default tuning
- **WHEN** a guitar stem is first shown as tab
- **THEN** it uses standard tuning with no capo

#### Scenario: Drop D
- **WHEN** a user changes the guitar tuning to drop D
- **THEN** the tab is redrawn with the sixth string a whole step lower
- **AND** no transcription model runs

#### Scenario: Capo
- **WHEN** a user sets a capo at the second fret
- **THEN** fret numbers are shown relative to the capo and no note is placed below it

#### Scenario: Choice is remembered
- **WHEN** a user sets drop D, closes the song and opens it again
- **THEN** the guitar tab is in drop D

### Requirement: Notes the instrument cannot play are not silently dropped
When a note is outside the range of the chosen tuning and capo, or a group of simultaneous notes cannot be fingered together, the system SHALL keep the notes it can place, SHALL leave the others out of the tab staff, and SHALL tell the user how many notes were left out. The staff notation, when shown, SHALL still contain every note.

#### Scenario: Note below the lowest string
- **WHEN** a transcribed bass note is below the open fourth string of a four-string bass
- **THEN** that note is absent from the tab staff
- **AND** the view reports that one note could not be placed and suggests a five-string or lower tuning

#### Scenario: Too many notes at once
- **WHEN** seven notes sound together on a six-string guitar
- **THEN** six are placed and one is reported as left out

### Requirement: A suggested tuning is offered
When more than a small share of a fretted stem's notes cannot be placed in the current tuning, the system SHALL suggest the offered tuning that places the most notes.

#### Scenario: Song in drop D
- **WHEN** a guitar stem holds many notes a whole step below the standard sixth string
- **THEN** the view suggests drop D
