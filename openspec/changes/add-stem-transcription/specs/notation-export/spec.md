# Spec Delta

## Purpose

Lets a musician take a song's transcription out of StemDeck as a MIDI file for a DAW or as a MusicXML score for a notation program, with one track or part per stem.

## ADDED Requirements

### Requirement: Transcription downloads as a MIDI file
The system SHALL provide a song's transcription as one Standard MIDI File with one track per transcribed stem, each track named after its stem. The download SHALL accept a list of stems and SHALL include every transcribed stem when none is given. The `drums` track SHALL be on the General MIDI percussion channel.

#### Scenario: All transcribed stems
- **WHEN** a user downloads the MIDI file of a song with `vocals`, `bass` and `drums` transcribed
- **THEN** the file holds three tracks named `vocals`, `bass` and `drums`
- **AND** the `drums` track is on the percussion channel

#### Scenario: Chosen stems
- **WHEN** a user downloads the MIDI file for the `bass` stem only
- **THEN** the file holds only the `bass` track

#### Scenario: Nothing transcribed
- **WHEN** a user asks for the MIDI file of a song with no transcription
- **THEN** the system answers that there is nothing to download

### Requirement: MIDI is available as played or quantised
The MIDI download SHALL be offered in two forms. The as-played form keeps note times as transcribed. The quantised form places notes on the beat grid and carries a tempo map and time signatures taken from that grid, so that it lines up with bar lines in a DAW and still plays in time with the song's audio.

#### Scenario: As-played form
- **WHEN** a user downloads the as-played MIDI file
- **THEN** each note starts and ends at the time it was transcribed, to within a few milliseconds

#### Scenario: Quantised form stays in sync
- **WHEN** a user loads the quantised MIDI file into a DAW beside the song's stems, both starting at zero
- **THEN** the notes sit on the DAW's grid
- **AND** each bar line falls on the corresponding downbeat of the audio throughout the song

#### Scenario: No beat grid
- **WHEN** a user asks for the quantised MIDI file of a song with no beat grid
- **THEN** the system refuses with a reason that names the missing beat grid
- **AND** the as-played form is still available

### Requirement: Transcription downloads as a MusicXML score
The system SHALL provide the quantised transcription as a MusicXML score with one part per transcribed stem, bars and time signatures taken from the beat grid, a tempo marking, and the song's detected key as the key signature when one is known. The `drums` part SHALL use percussion notation, and `bass` SHALL use a bass clef.

#### Scenario: Lead sheet parts
- **WHEN** a user downloads the MusicXML score of a 4/4 song with `vocals` and `bass` transcribed
- **THEN** the score has two parts, each divided into 4/4 bars
- **AND** it opens in a notation program without errors

#### Scenario: Note across a bar line
- **WHEN** a quantised note starts in one bar and ends in the next
- **THEN** the score shows it as tied notes across the bar line

#### Scenario: Meter change
- **WHEN** the beat grid marks a change from four to three beats per bar
- **THEN** the score changes time signature at that bar

#### Scenario: No beat grid
- **WHEN** a user asks for the MusicXML score of a song with no beat grid
- **THEN** the system refuses with a reason that names the missing beat grid

### Requirement: Exported files are named after the song
Downloaded MIDI and MusicXML files SHALL be named after the song, the way the song's other downloads are.

#### Scenario: File name
- **WHEN** a user downloads the MusicXML score of a song titled "Blue in Green"
- **THEN** the file name begins with the song's title and ends in `.musicxml`
