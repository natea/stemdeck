# Spec Delta

## Purpose

Gives the player structured ways to internalise bricks and joins: generated backings to play over, all-keys practice on real recordings, drills that test hearing and knowing where you are, and a record of progress that suggests what to learn next.

## ADDED Requirements

### Requirement: One brick repeated in one key
The system SHALL generate a backing that repeats one chosen brick in one chosen key at least twelve times, with a bass part, a chord part and a click, at a tempo the user sets, after a count-in. The user SHALL be able to choose the major or minor form.

#### Scenario: Twelve goes at a cadence
- **WHEN** a user starts a drill on the plain cadence in F at 100 beats per minute
- **THEN** after a count-in the backing plays G minor, C dominant, F major twelve times in a row at that tempo and then stops

#### Scenario: Keep going
- **WHEN** the user turns on repeat for the drill
- **THEN** the backing keeps repeating the brick until the user stops it

### Requirement: One join carried through the keys
The system SHALL generate a backing that plays one chosen brick once in each key, moving from key to key by one chosen join, until it returns to the starting key. Where a join does not reach all twelve keys, the system SHALL offer the further sequences needed to cover the keys it missed.

#### Scenario: A join that reaches every key
- **WHEN** a user starts a plain cadence drill joined by Bootstraps from C
- **THEN** the backing plays the cadence once in each of the twelve keys and ends back in C

#### Scenario: A join that reaches six keys
- **WHEN** a user starts a plain cadence drill joined by Woodys from C
- **THEN** the backing visits six keys before returning to C
- **AND** a second sequence starting a half step away is offered to cover the other six

#### Scenario: A join that reaches three keys
- **WHEN** a join reaches only three keys per sequence
- **THEN** four sequences are offered and together they cover all twelve keys

### Requirement: The player controls how much help the backing gives
During a generated drill the system SHALL let the user set the level of the bass, the chords and the click independently, including silencing any of them, and choose what is shown: the chords, the brick and join names only, or only the name of the key at the start of each pass.

#### Scenario: Pianist drops the chords
- **WHEN** the user silences the chord part
- **THEN** only the bass and click are heard and the drill continues

#### Scenario: Nothing to read
- **WHEN** the user chooses to see only the key name
- **THEN** no chords and no brick names are shown while the backing plays

### Requirement: Generated drills do not disturb the song
Starting a generated drill SHALL pause any song that is playing. The drill SHALL NOT change the song's position, loop, speed, transposition or mix, and the song SHALL stay paused when the drill ends.

#### Scenario: Start a drill during a song
- **WHEN** a user starts a generated drill while a song is playing
- **THEN** the song pauses, the drill plays, and afterwards the song is still paused at the same position with the same mix

### Requirement: All-keys practice on a real recording
The system SHALL loop a chosen stretch of a song and move the song's transposition to the next key on each pass, in an order the user chooses (round the cycle or by half steps), until all twelve keys have been played, and then return the song to the transposition it had. The view SHALL show the key of the current pass.

#### Scenario: A brick through all keys
- **WHEN** a user starts all-keys practice on a four-bar brick in cycle order
- **THEN** the brick plays twelve times, each in a different key, and the song returns to its original transposition

#### Scenario: Stop part way
- **WHEN** the user stops all-keys practice after five passes
- **THEN** the song returns to its original transposition

#### Scenario: Transposition is unavailable
- **WHEN** transposition is not available for the song
- **THEN** all-keys practice is not offered and the system says why

### Requirement: Real examples of one brick, back to back
The system SHALL play, one after another, every place in the library where a chosen brick or join occurs, each looped a set number of times, and SHALL show the song, section and key of each.

#### Scenario: Every Pennies ending in the library
- **WHEN** a user asks to practise the Pennies ending on real recordings and three songs contain it
- **THEN** the three stretches play in turn, each the chosen number of times, with the song and key named

#### Scenario: No examples
- **WHEN** no chart in the library contains the chosen brick
- **THEN** the system says there are no examples yet and offers the generated drill instead

### Requirement: "Where am I?" drill
The system SHALL start a song with a placed chart at a random moment inside a chorus with the roadmap and playback position hidden, let the user say which section is playing, and then reveal the roadmap, the correct section and how long the answer took.

#### Scenario: Correct answer
- **WHEN** the drill starts in the bridge and the user answers "B" after nine seconds
- **THEN** the system confirms the answer, shows nine seconds, and reveals the roadmap at the current bar

#### Scenario: Wrong answer
- **WHEN** the user names a section that is not playing
- **THEN** the system says which section it was and reveals the roadmap at the current bar

#### Scenario: Any song in a set
- **WHEN** the user runs the drill over all songs with placed charts
- **THEN** the song is also chosen at random and its title is hidden until the answer

### Requirement: Ear quiz for joins and bricks
The system SHALL play a brick, or two bricks connected by a join, in a random key with no names shown, ask the user to name the join or the brick from a set they chose, say whether the answer is right, and offer to play the example again.

#### Scenario: Name the join
- **WHEN** the quiz plays a cadence resting on G followed by a cadence starting on B flat, and the user answers Cherokee
- **THEN** the system confirms the answer and moves to the next example

#### Scenario: Limited set
- **WHEN** the user limits the quiz to four joins
- **THEN** every example uses one of those four

### Requirement: Timed quiz on the cycle and scale degrees
The system SHALL ask timed questions that name the note on a given degree of a given major key and the next key round the cycle in either direction, and SHALL report the score, the time taken and the keys answered slowly or wrongly.

#### Scenario: Degree of a key
- **WHEN** the question is "V of D flat" and the user answers A flat
- **THEN** the answer is marked correct

#### Scenario: Weak keys
- **WHEN** a quiz ends with two wrong answers in F sharp
- **THEN** the result lists F sharp as a key to work on

### Requirement: Practice progress is recorded
The system SHALL record, for each brick, join and key, when the user last practised it and their recent quiz results, and SHALL let the user mark a brick or join as learned. The record SHALL persist across restarts and SHALL be the same on every device that opens the library.

#### Scenario: Progress survives a restart
- **WHEN** a user marks the long cadence as learned and restarts StemDeck
- **THEN** the long cadence is still marked as learned

#### Scenario: Clear progress
- **WHEN** the user resets their practice progress
- **THEN** no brick is marked as learned and all practice history is gone

### Requirement: Learning path
The system SHALL list the songs in the library whose every brick and join the user has marked as learned, and SHALL suggest as the next thing to learn the brick or join that would add the most songs to that list. When the library has too few charts to compare, it SHALL suggest from a built-in order that starts with the plain cadence, the launcher and the hover.

#### Scenario: A brick that unlocks songs
- **WHEN** learning the dropback would complete three more songs and no other brick would complete more than one
- **THEN** the dropback is suggested first and the three songs are named

#### Scenario: Empty library
- **WHEN** the library has no charts
- **THEN** the plain cadence is suggested first
