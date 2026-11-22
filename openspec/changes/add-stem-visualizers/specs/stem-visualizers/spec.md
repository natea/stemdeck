# Spec Delta

## Purpose

Shows a song's stems as moving 3D pictures that follow playback and the mixer, so that people who do not read waveforms or notation can see what each instrument is doing, and keeps every such picture cheap to add and cheap to remove.

## ADDED Requirements

### Requirement: A song can be opened in the Visualizer
The system SHALL offer a Visualizer view for a finished song, marked as experimental, that opens over the studio and closes back to it with the song, its position and its mix unchanged. The view SHALL let the user choose among the installed visualizations and SHALL remember the last one chosen.

#### Scenario: Open and close
- **WHEN** a user opens the Visualizer while a song is playing, then closes it
- **THEN** playback never stops, and the studio is as it was

#### Scenario: Choose a visualization
- **WHEN** a user picks another visualization from the list
- **THEN** the picture changes to it without interrupting playback

#### Scenario: Choice is remembered
- **WHEN** a user picks a visualization, closes the Visualizer and opens it again
- **THEN** it opens on the one they picked

#### Scenario: Nothing installed
- **WHEN** no visualization is installed
- **THEN** the Visualizer is not offered at all

### Requirement: The picture follows playback
Every visualization SHALL show the moment of the song being heard, driven by StemDeck's own player, and SHALL stay in step when playback is paused, sought, slowed down or looped.

#### Scenario: Playing
- **WHEN** the song plays through a loud drum hit
- **THEN** the visualization shows that hit as it is heard, within a small fraction of a beat

#### Scenario: Paused
- **WHEN** playback is paused
- **THEN** the picture holds at that moment

#### Scenario: Seek and loop
- **WHEN** the user seeks, or a loop jumps back to its start
- **THEN** the picture jumps to the same moment

#### Scenario: Half speed
- **WHEN** playback is slowed to 0.5x
- **THEN** the picture moves at half pace and stays on the moment being heard

### Requirement: The picture follows the mixer
Every visualization SHALL show each stem in the colour StemDeck uses for it, SHALL dim or hide a stem that is muted, and SHALL show only the soloed stems when any stem is soloed.

#### Scenario: Mute
- **WHEN** the user mutes the bass
- **THEN** the bass's part of the picture goes dark while the others continue

#### Scenario: Solo
- **WHEN** the user solos the vocals
- **THEN** only the vocals' part of the picture is lit

### Requirement: The Visualizer is silent and read-only
The Visualizer SHALL NOT produce sound and SHALL NOT change the song, its stems, its transcription or its mix.

#### Scenario: Nothing is written
- **WHEN** a user opens the Visualizer, tries every visualization and closes it
- **THEN** no request that changes the song has been sent

### Requirement: Visualizations work without transcribed notes, or say why not
A visualization SHALL use a song's transcribed notes when it has them. When a song has none, a visualization SHALL either draw from loudness and beats alone, or state that it needs notes and offer the Transcribe action. It SHALL NOT show an empty or broken scene.

#### Scenario: Song with no transcription, loudness is enough
- **WHEN** a user opens a visualization that can draw from loudness on a song that was never transcribed
- **THEN** the picture moves with each stem's loudness and the beat

#### Scenario: Song with no transcription, notes are required
- **WHEN** a user opens a visualization that needs notes on a song that was never transcribed
- **THEN** the view says that this one needs the song's notes and offers Transcribe

#### Scenario: Some stems transcribed
- **WHEN** only the bass has been transcribed
- **THEN** the bass is drawn from its notes and the other stems from loudness

#### Scenario: No beat grid
- **WHEN** a song has no beat grid
- **THEN** the visualization still follows playback and loudness, without beat or bar marks

### Requirement: The Visualizer stays responsive
The Visualizer SHALL keep the app usable: it SHALL stop drawing when it is closed or the window is hidden, SHALL lower its own detail before it lets the frame rate fall to where the picture stutters, and SHALL NOT make audio playback glitch.

#### Scenario: Closed
- **WHEN** the Visualizer is closed
- **THEN** it does no drawing work and holds no graphics memory

#### Scenario: Long, dense song
- **WHEN** a song has tens of thousands of notes
- **THEN** the picture still moves smoothly, with detail reduced if needed

#### Scenario: Window hidden
- **WHEN** the app's window is hidden or minimised
- **THEN** drawing pauses until it is shown again

### Requirement: The Visualizer degrades gracefully
Where 3D graphics are unavailable or fail to start, the Visualizer SHALL say so in plain words and leave the studio working. When the user has asked the system for reduced motion, the Visualizer SHALL NOT move the camera or flash, and SHALL show a calm version or a still picture.

#### Scenario: No 3D graphics
- **WHEN** the browser cannot create a 3D graphics context
- **THEN** the view says that this computer cannot show the Visualizer, and closes cleanly

#### Scenario: One visualization fails
- **WHEN** a visualization throws an error while starting or drawing
- **THEN** the view says that this one failed, the others can still be chosen, and playback continues

#### Scenario: Reduced motion
- **WHEN** the system's reduce-motion setting is on
- **THEN** the camera does not travel and nothing flashes

### Requirement: Everything the Visualizer needs is served by StemDeck
The Visualizer SHALL work with no internet connection and inside the desktop app.

#### Scenario: No network
- **WHEN** the machine is offline
- **THEN** every visualization still loads and draws

### Requirement: Any visualization can be removed cleanly
Each visualization SHALL be self-contained, so that removing it leaves the Visualizer and every other visualization working, and leaves behind no text, style, test or code that refers to it. Removing the last one SHALL leave the app without a Visualizer entry and otherwise unchanged. The project SHALL provide a documented, single-step way to remove one, and the same for the whole Visualizer.

#### Scenario: Remove one
- **WHEN** a maintainer removes the Song planet visualization the documented way
- **THEN** the other five still work, the list no longer shows it, and a search of the project for its name finds nothing

#### Scenario: A visualization's files are missing
- **WHEN** a visualization is listed but its files cannot be loaded
- **THEN** the Visualizer leaves it out of the list and the rest work

#### Scenario: Remove the Visualizer
- **WHEN** a maintainer removes the whole Visualizer the documented way
- **THEN** the studio has no Visualizer entry, every existing test still passes, and the 3D library is gone from the project

### Requirement: Note terrain
The Note terrain visualization SHALL draw the song as a landscape of blocks travelling toward the viewer: time along the direction of travel, pitch across, block height from how hard a note was played, colour by stem, with the blocks at the present moment lit. Without notes it SHALL draw one ridge per stem from loudness.

#### Scenario: Bass line
- **WHEN** a transcribed bass line walks up a scale
- **THEN** its blocks step across the landscape in pitch order as they arrive

#### Scenario: Without notes
- **WHEN** the song has no transcription
- **THEN** each stem is a ridge whose height follows its loudness

### Requirement: Note galaxy
The Note galaxy visualization SHALL draw one spiral arm per stem and SHALL emit a burst of particles for each note as it sounds, at a distance from the centre set by its pitch and with a size set by how hard it was played. It needs notes.

#### Scenario: Notes sounding
- **WHEN** a guitar chord sounds
- **THEN** several bursts appear together on the guitar's arm at their pitches' distances

#### Scenario: Without notes
- **WHEN** the song has no transcription
- **THEN** the view says this visualization needs the song's notes and offers Transcribe

### Requirement: Song planet
The Song planet visualization SHALL wrap the whole song once around a small sphere, with each stem as a band of terrain raised by its loudness and each section as a region of its own colour, and SHALL move the viewpoint around the sphere as the song plays so that one lap is one song.

#### Scenario: Position in the song
- **WHEN** playback is halfway through the song
- **THEN** the viewpoint is halfway around the planet

#### Scenario: Sections
- **WHEN** the song has marked sections
- **THEN** each section is a visibly different region

### Requirement: Slit-scan score
The Slit-scan score visualization SHALL draw the whole song as one strip, one column per moment, with each stem a colour band whose brightness follows its loudness and, where notes exist, whose marks follow pitch, and SHALL mark the present moment on the strip. Clicking the strip SHALL move the song to that moment.

#### Scenario: Whole song at a glance
- **WHEN** the view opens
- **THEN** the full length of the song is visible at once, with quiet and loud passages distinguishable per stem

#### Scenario: Seek from the strip
- **WHEN** a user clicks two thirds of the way along the strip
- **THEN** the song's position moves to two thirds of its length

### Requirement: Lit stage
The Lit stage visualization SHALL show a small stage with a keyboard, a guitar fretboard, a bass fretboard and a drum kit, and SHALL light the key, fret position or drum piece of each note as it sounds, fading afterwards. Vocals SHALL be shown as a light whose height follows the sung pitch. It needs notes.

#### Scenario: Piano note
- **WHEN** a transcribed piano note sounds
- **THEN** the matching key lights and then fades

#### Scenario: Drum hit
- **WHEN** a kick and a hi-hat sound together
- **THEN** the kick drum and the hi-hat both light

#### Scenario: Stem not transcribed
- **WHEN** the guitar was not transcribed
- **THEN** the guitar's instrument is shown unlit with a note that it has no notes yet

### Requirement: Drive the song
The Drive the song visualization SHALL move the viewer along a road at a pace set by the song's tempo, with bar lines as markers on the road, drum hits as bumps, the other stems as lights or structures beside the road raised by their loudness, and each section as a change of scenery.

#### Scenario: Tempo sets the pace
- **WHEN** two songs at 80 and 160 beats per minute are driven
- **THEN** the faster song's road passes at twice the pace

#### Scenario: Drum hits
- **WHEN** a snare hit sounds
- **THEN** a bump passes under the viewer as it is heard
