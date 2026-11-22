# Spec Delta

## ADDED Requirements

### Requirement: Transcription downloads as a Guitar Pro file
The system SHALL provide the quantised transcription as a Guitar Pro (`.gp`) file with one track per chosen stem, carrying the same bars, time signatures, tempo and notes as the Notation view, and the string, fret, tuning and capo of each fretted stem. The download SHALL accept a list of stems and SHALL be named after the song.

#### Scenario: Open in a tab editor
- **WHEN** a user downloads the Guitar Pro file of a song with `guitar` and `bass` transcribed and opens it in a tab editor
- **THEN** the file opens without errors with a guitar track and a bass track
- **AND** each track shows the same frets as StemDeck's Notation view

#### Scenario: Tuning carried over
- **WHEN** the guitar stem is set to drop D with a capo at the second fret
- **THEN** the Guitar Pro track has that tuning and capo

#### Scenario: No beat grid
- **WHEN** a user asks for the Guitar Pro file of a song with no beat grid
- **THEN** the system refuses with a reason that names the missing beat grid

### Requirement: The MusicXML score carries tablature for fretted stems
For the `guitar` and `bass` stems, the MusicXML score SHALL include each note's string and fret and the part's tuning and capo, so that a notation program can show the part as tablature. Staff notation for those parts SHALL remain complete.

#### Scenario: Tab in a notation program
- **WHEN** a user opens the MusicXML score in a notation program and adds a tab staff to the guitar part
- **THEN** the fret numbers match StemDeck's Notation view

#### Scenario: Unplaceable note
- **WHEN** a note of a fretted stem could not be given a string and fret
- **THEN** it is still present in the score's staff notation, without string and fret
