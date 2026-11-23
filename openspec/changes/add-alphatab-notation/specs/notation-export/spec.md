# Spec Delta

## ADDED Requirements

### Requirement: Transcription downloads as a Guitar Pro file
The system SHALL provide the quantised transcription as a Guitar Pro (`.gp`) file with one track per chosen stem, carrying the same bars, time signatures, tempo and notes as the Notation view, and the string, fret, tuning and capo of each fretted stem. The download SHALL accept a list of stems and SHALL be named after the song. It SHALL be saved the same way as the other downloads, in a browser and in the desktop app.

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

#### Scenario: Saved from the desktop app
- **WHEN** a user downloads the Guitar Pro file in the desktop app
- **THEN** the app asks where to save it, offering the song's name with `.gp`
- **AND** the file saved there is the one the Notation view made

### Requirement: The MusicXML score carries tablature for fretted stems
For the `guitar` and `bass` stems, the MusicXML score SHALL include a tab staff under the part's staff notation, with each placed note's string and fret and the part's tuning and capo, so that a notation program shows the part as tablature when the file opens. Staff notation for those parts SHALL remain complete.

#### Scenario: Tab in a notation program
- **WHEN** a user opens the MusicXML score in a notation program
- **THEN** the guitar part shows a staff of notation and a tab staff
- **AND** the fret numbers on the tab staff match StemDeck's Notation view

#### Scenario: Unplaceable note
- **WHEN** a note of a fretted stem could not be given a string and fret
- **THEN** it is still present in the score's staff notation
- **AND** it is left off the tab staff
