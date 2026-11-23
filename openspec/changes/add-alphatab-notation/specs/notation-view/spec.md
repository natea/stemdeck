# Spec Delta

## Purpose

Shows a song's transcribed stems as engraved music inside StemDeck and keeps the score in step with the song as it plays, so a musician can read a part while practising it.

## ADDED Requirements

### Requirement: A transcribed song can be read as notation in the app
The system SHALL offer a Notation view for a song that has at least one transcribed stem and a beat grid, showing each chosen stem as a staff with bars, time signatures, a tempo marking and the song's key signature when one is known. The `drums` stem SHALL be shown in percussion notation.

#### Scenario: Open the view
- **WHEN** a user opens the Notation view for a song with `vocals` and `bass` transcribed
- **THEN** the view shows two staves, one per stem, each labelled with its stem name
- **AND** the bars match the song's beat grid

#### Scenario: Drums
- **WHEN** the `drums` stem is shown
- **THEN** it is drawn on a percussion staff, with kick, snare and cymbals on their usual lines

#### Scenario: Long song
- **WHEN** a user opens the view for a song of several hundred bars
- **THEN** the first bars are readable within a few seconds and the rest fills in without freezing the app

### Requirement: The view says why there is nothing to show
When a song cannot be shown as notation, the view SHALL say why and offer the next step instead of showing an empty score.

#### Scenario: Nothing transcribed yet
- **WHEN** a user opens the Notation view for a song with no transcription
- **THEN** the view explains that the song has not been transcribed and offers the Transcribe action

#### Scenario: No beat grid
- **WHEN** a user opens the view for a transcribed song with no beat grid
- **THEN** the view explains that notation needs a beat grid
- **AND** points to the as-played MIDI download, which does not need one

#### Scenario: Transcription not available on this machine
- **WHEN** StemDeck runs where transcription is unavailable
- **THEN** the Notation view is not offered

### Requirement: The score follows playback
While the song plays, the view SHALL show a cursor at the position being heard, driven by StemDeck's own player, and SHALL scroll so the cursor stays visible. The cursor SHALL stay in step when the playback speed is changed, when a loop repeats, and after a seek. The scrolling SHALL keep working after the score is drawn again while the song plays. The user SHALL be able to turn the scrolling off, to scroll the score themselves, and on again; the choice SHALL be remembered for the song.

#### Scenario: Playing
- **WHEN** the song plays through the downbeat of bar 12
- **THEN** the cursor is at the start of bar 12 at that moment, to within a small fraction of a beat

#### Scenario: Half speed
- **WHEN** the user slows playback to 0.5x
- **THEN** the cursor moves at half the pace and stays on the bar being heard

#### Scenario: Loop
- **WHEN** a looped region jumps back to its start
- **THEN** the cursor jumps back with it

#### Scenario: Tempo drift
- **WHEN** the song's tempo changes during a section
- **THEN** the cursor still reaches each bar line as that bar's downbeat is heard

#### Scenario: Playback paused
- **WHEN** playback is paused
- **THEN** the cursor stays where the song stopped

#### Scenario: Redrawn while playing
- **WHEN** the user unticks a stem, or changes the resolution, while the song plays
- **THEN** the score is drawn again and still scrolls to each system as the song reaches it

#### Scenario: Follow turned off
- **WHEN** the user turns Follow off and the song plays past the part of the score on show
- **THEN** the cursor moves on and the score stays where the user left it

#### Scenario: Follow turned on again
- **WHEN** the user turns Follow on while the bar being played is out of view
- **THEN** the score scrolls to that bar at once

### Requirement: Clicking the score moves the song
The user SHALL be able to click a bar or beat in the score to move the song's playback position there.

#### Scenario: Seek from the score
- **WHEN** a user clicks the first beat of bar 20
- **THEN** the song's position moves to the time of that beat
- **AND** the waveform and every other part of the player show the same position

### Requirement: The view is silent
The Notation view SHALL NOT produce sound of its own. The stems the user hears, with their mute, solo, volume, speed and key settings, are unchanged by opening or using the view.

#### Scenario: Open while playing
- **WHEN** a user opens the Notation view while the song is playing
- **THEN** playback continues without a gap and no extra sound is added

### Requirement: The user chooses what the score shows
The user SHALL be able to choose which transcribed stems are shown, the zoom, and the quantisation resolution. These choices SHALL be remembered for the song.

#### Scenario: Hide a stem
- **WHEN** a user unticks `drums` in the view
- **THEN** the drum staff is removed and the other staves are laid out again

#### Scenario: Change resolution
- **WHEN** a user changes the resolution from four to three parts per beat
- **THEN** the score is redrawn on a triplet grid

#### Scenario: Choices persist
- **WHEN** a user hides `drums`, closes the song and opens it again
- **THEN** the Notation view opens with `drums` hidden

### Requirement: The score follows edits to the beat grid and new transcriptions
The view SHALL show the transcription as it currently is: after the beat grid is edited or a stem is transcribed again, the score SHALL reflect it the next time it is shown, without the user clearing anything.

#### Scenario: Grid corrected
- **WHEN** a user fixes the beat grid and returns to the Notation view
- **THEN** the bars and note positions reflect the corrected grid

#### Scenario: Stem transcribed again
- **WHEN** a stem is transcribed again while the view is open
- **THEN** the view shows the new notes once the transcription finishes

### Requirement: The view works offline and inside the desktop app
Everything the Notation view needs to draw a score SHALL be served by StemDeck itself. The view SHALL work with no internet connection and inside the desktop app.

#### Scenario: No network
- **WHEN** the machine has no internet connection
- **THEN** the Notation view draws the score with its music font

### Requirement: The view offers the downloads
The Notation view SHALL offer the song's notation downloads (MIDI as played, MIDI quantised, MusicXML, Guitar Pro) for the stems currently shown.

#### Scenario: Download from the view
- **WHEN** a user with `bass` and `guitar` shown chooses the MusicXML download
- **THEN** the downloaded score holds the `bass` and `guitar` parts
