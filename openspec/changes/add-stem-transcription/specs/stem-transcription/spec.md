# Spec Delta

## Purpose

Turns the separated stems of a finished song into note data (pitch, start, end, velocity) on demand, in an as-played form and a form snapped to the song's own beat grid, so a musician can read or export what each instrument plays.

## ADDED Requirements

### Requirement: Transcription runs on demand for a finished song
The system SHALL transcribe stems only when asked, for a song whose separation has finished, and SHALL accept a list of stems to transcribe. When no list is given it SHALL transcribe every stem the song has that is not silent.

#### Scenario: Transcribe chosen stems
- **WHEN** a user asks to transcribe the `bass` and `piano` stems of a finished song
- **THEN** the system transcribes those two stems and no others
- **AND** the song's state reports transcription as running, then done

#### Scenario: Song is not finished
- **WHEN** a user asks to transcribe a song that is still importing or has failed
- **THEN** the system refuses the request and starts no work

#### Scenario: Stem does not exist
- **WHEN** a user asks to transcribe a stem the song does not have
- **THEN** the system refuses the request and names the unknown stem

#### Scenario: Silent stem is skipped
- **WHEN** a user asks to transcribe every stem and the song's `piano` stem is silent
- **THEN** the system transcribes the other stems and records `piano` as skipped, with no notes

### Requirement: Each stem is transcribed by the model suited to it
The system SHALL route each stem to one kind of transcriber by stem name: a monophonic pitch tracker for `vocals`, `lead_vocals` and `bass`; a piano transcriber for `piano`; a multi-instrument polyphonic transcriber for `guitar`, `other` and `backing_vocals`; and a drum transcriber for `drums`. The result for each stem SHALL record which transcriber produced it.

#### Scenario: Bass stem
- **WHEN** the `bass` stem is transcribed
- **THEN** its result holds at most one note sounding at any time
- **AND** records that the monophonic pitch tracker produced it

#### Scenario: Piano stem
- **WHEN** the `piano` stem is transcribed
- **THEN** its result may hold several notes sounding at once
- **AND** records that the piano transcriber produced it

#### Scenario: Drums stem
- **WHEN** the `drums` stem is transcribed
- **THEN** each note's pitch is a General MIDI percussion key (for example 36 for a kick, 38 for a snare)

### Requirement: A pitch curve is turned into discrete notes
For stems routed to the monophonic pitch tracker, the system SHALL convert the tracked frequency curve into notes: each note has one MIDI pitch, a start, an end and a velocity. Unvoiced or low-confidence stretches SHALL produce no note, vibrato around one pitch SHALL stay one note, and notes shorter than a minimum length SHALL be dropped or merged.

#### Scenario: Held note with vibrato
- **WHEN** a singer holds one pitch for two seconds with vibrato of less than half a semitone either side
- **THEN** the result holds one note of about two seconds at that pitch

#### Scenario: Step between two pitches
- **WHEN** the pitch moves from A3 to B3 and stays there
- **THEN** the result holds an A3 note followed by a B3 note, with the boundary where the pitch changed

#### Scenario: Silence and breath
- **WHEN** a stretch of the stem is silent or unpitched
- **THEN** the result holds no note for that stretch

#### Scenario: Repeated note
- **WHEN** the same pitch is played twice with a clear new attack between
- **THEN** the result holds two notes, not one long note

### Requirement: Notes are stored as played
The system SHALL keep each stem's transcription with note times in seconds from the start of the song, exactly as the transcriber found them, and SHALL keep it with the song so it survives a restart and travels with the song's folder.

#### Scenario: Result survives a restart
- **WHEN** a song's stems have been transcribed and the server restarts
- **THEN** the transcription is still available without running a model again

#### Scenario: Transcribing again replaces the stem's result
- **WHEN** a stem that already has a transcription is transcribed again
- **THEN** the new result replaces the old one for that stem only

### Requirement: Notes are quantised to the song's beat grid
The system SHALL offer a quantised form of a transcription in which each note's start and end are snapped to the nearest point of a grid made by dividing every beat of the song's beat grid into equal parts. The grid SHALL be the one the click track uses, including the user's edits, so that quantised positions follow tempo changes and bar lines come from the grid's downbeats. Each quantised note SHALL carry its bar, beat and subdivision.

#### Scenario: Slightly early note
- **WHEN** a note starts 30 ms before the third beat of a bar at sixteenth-note resolution
- **THEN** its quantised start is the third beat of that bar

#### Scenario: Tempo drifts
- **WHEN** the song speeds up from 100 to 108 BPM over a verse
- **THEN** notes played on the beat throughout stay on the beat in the quantised form

#### Scenario: Short note keeps a length
- **WHEN** a note's start and end snap to the same grid point
- **THEN** the quantised note is one grid step long

#### Scenario: Resolution is chosen
- **WHEN** a user asks for the quantised form at three parts per beat
- **THEN** every quantised position is on a triplet grid

### Requirement: Quantisation follows edits to the beat grid
The quantised form SHALL be derived from the stored as-played notes and the current beat grid at the time it is asked for. Changing the beat grid SHALL change the quantised form without running a transcription model.

#### Scenario: User corrects the grid
- **WHEN** a user moves the beats of a song after its stems were transcribed, then asks for the quantised form
- **THEN** the quantised positions reflect the edited grid
- **AND** no transcription model runs

### Requirement: Transcription works without a beat grid
When a song has no beat grid, the system SHALL still transcribe and store the as-played notes, and SHALL report the quantised form as unavailable with a reason. When the grid has beats but no bar marks, the system SHALL quantise using the user's beats-per-bar setting, or four beats per bar counted from the first beat.

#### Scenario: No beat grid
- **WHEN** a song whose beat detection failed is transcribed
- **THEN** the as-played notes are available
- **AND** a request for the quantised form is refused with a reason that names the missing beat grid

#### Scenario: Beats without downbeats
- **WHEN** a song's grid has beats but no bar marks and the user has set none
- **THEN** the quantised form counts bars of four beats from the first beat

### Requirement: A failed transcription leaves the song intact
A failure, a cancellation or an interruption of a transcription SHALL leave the song finished and playable with all its stems, SHALL keep the results of stems that completed, and SHALL report which stems failed with a reason code. The server restarting during a transcription SHALL be reported as interrupted, not left as running.

#### Scenario: One model cannot load
- **WHEN** the piano transcriber cannot be downloaded while transcribing `bass` and `piano`
- **THEN** the `bass` result is kept
- **AND** `piano` is reported as failed with a reason that names the model
- **AND** the song stays finished

#### Scenario: User cancels
- **WHEN** a user cancels a running transcription
- **THEN** the work stops, completed stems keep their results and the song stays finished

#### Scenario: Restart during a run
- **WHEN** the server restarts while a transcription is running
- **THEN** the song reports the transcription as interrupted and offers to start it again

### Requirement: Transcription does not run alongside other heavy work on a song
The system SHALL run one transcription at a time and SHALL NOT start one for a song while that song is being imported, having its vocals split, or having missing stems filled in.

#### Scenario: Second request while running
- **WHEN** a transcription is requested for a song that already has one running
- **THEN** the system refuses the second request

#### Scenario: Vocal split in progress
- **WHEN** a transcription is requested while the song's lead and backing vocal split is running
- **THEN** the system refuses the request as busy

### Requirement: Transcription is offered only where it can run
The system SHALL report whether transcription is available on the machine, and SHALL NOT offer it on platforms where its models cannot run.

#### Scenario: Intel Mac
- **WHEN** StemDeck runs on an Intel Mac
- **THEN** the app reports transcription as unavailable and shows no Transcribe control
- **AND** a transcription request is refused with that reason
