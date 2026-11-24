# Spec Delta

## Purpose

Shows one song as a single-page roadmap of sections, bricks, joins and chords that follows the recording, can be read in any key, and lets the user correct the analysis and loop any part of it.

## ADDED Requirements

### Requirement: Roadmap view for a song with a chart
The system SHALL provide a Roadmap view, marked as a Labs feature, for any song that has a chord chart. It SHALL lay the chorus out as a grid of bars, eight to a row by default, with a new row at each section, and SHALL show for each bar its chords and, above them, the brick the bar belongs to and any join that happens at its start.

#### Scenario: Open the roadmap
- **WHEN** a user opens the Roadmap view on a song with a 32-bar AABA chart
- **THEN** four rows of eight bars are shown, labelled A, A, B and A, with brick names above the chords and join names where bricks meet

#### Scenario: Song has no chart
- **WHEN** a user opens the Roadmap view on a song with no chart
- **THEN** the view explains what a chart is and offers to add one, and shows no roadmap

#### Scenario: A section that is not a multiple of eight bars
- **WHEN** a chart has a 12-bar section
- **THEN** the section is drawn as a row of eight bars and a row of four

### Requirement: Opening the roadmap leaves playback alone
Opening, using and closing the Roadmap view SHALL NOT stop, restart or change the mix of the song that is playing, and the view SHALL be unavailable while Karaoke or Performance is open.

#### Scenario: Open during playback
- **WHEN** a user opens and closes the Roadmap view while a song is playing
- **THEN** playback continues without a gap and no stem's volume, mute or solo state changes

### Requirement: The roadmap follows the recording
While a song plays, the system SHALL highlight the bar, the brick and the section that are sounding and SHALL show which chorus is playing. When playback is outside every chorus it SHALL highlight nothing and say so.

#### Scenario: Playing through a chorus
- **WHEN** playback reaches bar 5 of the second chorus
- **THEN** bar 5 and its brick are highlighted and the view shows chorus 2

#### Scenario: Seek
- **WHEN** the user seeks to another point in the song
- **THEN** the highlight moves to the bar at the new position within one beat

#### Scenario: Intro
- **WHEN** playback is before the first chorus
- **THEN** no bar is highlighted and the view shows that the chorus has not started

### Requirement: Harmony character is visible at a glance
The system SHALL mark bricks in their minor form, chords that carry tension, and bricks that rest away from home so that each can be told apart from the default. It SHALL NOT rely on colour alone to do so.

#### Scenario: Minor cadence
- **WHEN** a roadmap contains a major cadence and a minor cadence
- **THEN** the minor one is visibly marked as minor by more than its colour

### Requirement: The roadmap can be shown in any key
The system SHALL show the roadmap's chords in any of the twelve keys and for concert, B flat and E flat instruments, leaving brick and join names unchanged. By default the chords SHALL match what is heard, including the song's current transposition.

#### Scenario: Song transposed in the player
- **WHEN** the user transposes the song up two semitones in the player
- **THEN** the chords in the roadmap move up two semitones and the brick and join names stay the same

#### Scenario: B flat instrument
- **WHEN** the user chooses B flat instrument
- **THEN** every chord is written a whole tone higher and the sound does not change

#### Scenario: Names only
- **WHEN** the user hides the chords
- **THEN** only sections, brick names, join names and bar counts are shown

### Requirement: Looping from the roadmap
The system SHALL let the user loop a bar, a brick or a section by choosing it on the roadmap. The loop SHALL cover that stretch in the chorus that is playing, or the first chorus when nothing is playing, and SHALL be able to move to the same stretch in the next chorus each time round.

#### Scenario: Loop a brick
- **WHEN** the user chooses a four-bar cadence on the roadmap during the second chorus
- **THEN** the player loops those four bars of the second chorus

#### Scenario: Same brick, next chorus
- **WHEN** the user turns on "next chorus each time" for a looped brick
- **THEN** each pass plays that brick from the following chorus, returning to the first after the last

### Requirement: The user can correct the analysis
The system SHALL let the user rename the brick over a stretch of bars to any catalogue entry or to a name of their own, change where a brick starts and ends, set the home key of a section, and remove a label. Corrections SHALL be stored with the song, SHALL survive re-analysis, and SHALL be removable to return to the automatic result.

#### Scenario: Rename a brick
- **WHEN** the user changes a stretch labelled as a long cadence to a rainy cadence
- **THEN** the roadmap shows the rainy cadence there after a reload and after the chart's other bars are edited

#### Scenario: Chart edited under a correction
- **WHEN** the user changes the chords inside a stretch that carries a correction
- **THEN** the correction is kept and marked as needing review

#### Scenario: Back to automatic
- **WHEN** the user clears all corrections on a song
- **THEN** the roadmap shows the automatic analysis

### Requirement: Songs that share a brick can be found
From any brick or join on a roadmap, the system SHALL list the other songs in the library whose charts contain the same brick or join, and SHALL open a chosen song at that place.

#### Scenario: Other songs with the same join
- **WHEN** the user asks which songs contain a Bauble
- **THEN** every song in the library whose analysis contains a Bauble is listed with the section and bar where it happens

#### Scenario: Nothing else has it
- **WHEN** no other song in the library contains the chosen brick
- **THEN** the list says so

### Requirement: The roadmap can be printed
The system SHALL offer a print layout of the roadmap that fits one chorus on a single landscape page where its length allows, in the key and instrument setting currently shown.

#### Scenario: Print a 32-bar song
- **WHEN** the user prints the roadmap of a 32-bar song
- **THEN** the output is one landscape page with all four rows, the title, the key and the credit line
