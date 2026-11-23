# Spec Delta

## Purpose

Lets a StemDeck on one machine have a song's stems transcribed on a second machine the user runs, so that a faster GPU can do the slow part while the library, the player and the files stay where the user sits.

## ADDED Requirements

### Requirement: A transcription server turns one stem into notes
The system SHALL provide a transcription server that can be started on its own. Given one stem's audio and that stem's name, it SHALL return the stem's notes in the same form local transcription stores, naming the transcriber and model that produced them. It SHALL route a stem to a transcriber by the same table local transcription uses.

#### Scenario: Bass stem
- **WHEN** the server is sent a bass stem
- **THEN** it answers with that stem's notes, the transcriber it used and the audio's duration

#### Scenario: Silent stem
- **WHEN** the server is sent a stem with no sound in it
- **THEN** it answers that the stem was skipped as silent, without loading a model

#### Scenario: Unknown stem name
- **WHEN** the server is sent a stem name it has no transcriber for
- **THEN** it refuses the request and says the stem name is not one it transcribes

### Requirement: The server keeps nothing
The server SHALL NOT keep a library, and SHALL delete the audio it was sent and the notes it produced once it has answered, or once the request ends for any other reason. It SHALL NOT send audio or notes anywhere except back to the caller.

#### Scenario: After an answer
- **WHEN** the server has answered a request
- **THEN** no file from that request remains on the server

#### Scenario: Caller disappears
- **WHEN** the connection drops during a transcription
- **THEN** the work stops and that request's files are deleted

### Requirement: The server only answers callers with its token
The server SHALL require an access token on every request that sends audio or reads results, and SHALL refuse a request without the right one. It SHALL refuse to start listening on anything other than the local machine unless a token is set.

#### Scenario: Wrong token
- **WHEN** a request arrives with a missing or wrong token
- **THEN** the server refuses it and transcribes nothing

#### Scenario: Started open to the network without a token
- **WHEN** someone starts the server on a network address with no token configured
- **THEN** it does not start, and says a token is required

#### Scenario: Health check
- **WHEN** a caller with the right token asks the server about itself
- **THEN** it reports its version, its protocol version, the device it computes on and the transcribers it can run

### Requirement: The server does one transcription at a time and says so
The server SHALL run one transcription at a time. A request that arrives while another is running SHALL be answered as busy, not queued without limit and not run alongside.

#### Scenario: Second caller
- **WHEN** a stem arrives while another is being transcribed
- **THEN** the server answers that it is busy

### Requirement: Remote transcription is a setting, off by default
StemDeck SHALL have a setting holding a transcription server's address and access token. With it unset, StemDeck SHALL behave exactly as without this capability and SHALL send no audio anywhere. The setting SHALL be changeable in Settings and by environment variable, and the token SHALL NOT be shown back in full or written to logs.

#### Scenario: Unset
- **WHEN** no server is configured
- **THEN** transcription runs on this computer as before and no request leaves it

#### Scenario: Test the connection
- **WHEN** a user enters an address and token and presses Test
- **THEN** StemDeck shows the server's version, device and transcribers, or a plain reason it could not connect

#### Scenario: Token is not exposed
- **WHEN** the settings are read back or a run is logged
- **THEN** the token appears masked or not at all

### Requirement: With a server configured, stems are transcribed there
When a server is configured and enabled, a transcription run SHALL send each chosen stem to the server and store what comes back in the song's folder in the same form as a local result, recording that it was produced remotely. Everything downstream (quantising, MIDI, MusicXML, per-stem results in the song's state) SHALL behave as it does for local results.

#### Scenario: Remote run
- **WHEN** a user transcribes bass and guitar with a server configured
- **THEN** both stems are sent to the server, no transcription model loads on this computer, and the song ends with notes for both

#### Scenario: Results look the same
- **WHEN** a stem transcribed remotely is downloaded as MIDI or MusicXML
- **THEN** the file is produced the same way as for a locally transcribed stem

#### Scenario: Per-stem failure
- **WHEN** the server fails on one stem and succeeds on another
- **THEN** the successful stem keeps its notes and the failed one reports a reason, as in a local run

### Requirement: Only the stem's audio is sent
A remote run SHALL send the server the stem's audio and the stem's name, and nothing else about the song: not its title, source, tags, lyrics, other stems or library.

#### Scenario: What the server sees
- **WHEN** a stem is sent
- **THEN** the request holds the audio, the stem name and the token, and no song title or source link

### Requirement: StemDeck says where the audio goes
Wherever a remote run can be started or configured, StemDeck SHALL state that stem audio will be sent to the configured address, and SHALL show that address. A run SHALL record whether each stem was transcribed on this computer or on the server.

#### Scenario: In the dialog
- **WHEN** a user opens the Transcribe dialog with a server configured
- **THEN** the dialog says the stems will be sent to that address for transcription

#### Scenario: Afterwards
- **WHEN** a user looks at a transcribed stem
- **THEN** they can tell whether it was transcribed here or on the server

### Requirement: A failed link is reported, never papered over
When the server cannot be reached, refuses the token, is busy, or speaks an incompatible protocol version, the run SHALL end with a reason that names which of these happened, and the song SHALL stay finished with any notes it already had. StemDeck SHALL NOT fall back to transcribing on this computer on its own; it SHALL offer that as a choice where local transcription is possible.

#### Scenario: Server is off
- **WHEN** a run starts and the server does not answer
- **THEN** the run ends saying the transcription server could not be reached, and offers to run on this computer

#### Scenario: Wrong token
- **WHEN** the server refuses the token
- **THEN** the run ends saying the server refused the access token

#### Scenario: Version mismatch
- **WHEN** the server speaks a protocol version this StemDeck does not
- **THEN** the run ends saying the two need to be the same version, and no audio is sent

#### Scenario: Link drops mid-run
- **WHEN** the connection is lost after one stem finished and during the next
- **THEN** the finished stem keeps its notes and the run reports the link was lost

#### Scenario: No local fallback possible
- **WHEN** the server cannot be reached on a machine that cannot transcribe locally
- **THEN** the run ends with the reason and no offer to run here

### Requirement: Cancelling reaches the server
Cancelling a remote run in StemDeck SHALL stop the work on the server promptly, and SHALL leave stems that already finished with their notes.

#### Scenario: Cancel
- **WHEN** a user cancels during the second of three stems
- **THEN** the server stops that transcription, the third is never sent, and the first keeps its notes

### Requirement: A stalled server does not hang StemDeck
StemDeck SHALL treat a server that sends neither progress nor a result for longer than the transcription time limit as failed, and end the run with a timeout reason.

#### Scenario: Silent server
- **WHEN** the server accepts a stem and then sends nothing
- **THEN** after the time limit the run ends as timed out and StemDeck is free to start another

### Requirement: A configured server makes transcription available everywhere
StemDeck SHALL offer transcription on a machine that cannot run it locally when a transcription server is configured and enabled.

#### Scenario: Intel Mac with a server
- **WHEN** StemDeck runs on an Intel Mac with a server configured
- **THEN** the Transcribe control is shown, and a run uses the server

#### Scenario: Intel Mac without a server
- **WHEN** StemDeck runs on an Intel Mac with no server configured
- **THEN** transcription is not offered, as before
